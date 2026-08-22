param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,
  [string]$Region = "us-central1",
  [string]$ServiceName = "belay-intelligence",
  [string]$Model = "gemini-3.6-flash",
  [string]$Gcloud = "gcloud",
  [string]$GcloudConfig = "",
  [switch]$ValidateContextOnly
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$runtimeAccountName = "belay-intelligence"
$runtimeAccount = "$runtimeAccountName@$ProjectId.iam.gserviceaccount.com"
$builderAccountName = "belay-builder"
$builderAccount = "$builderAccountName@$ProjectId.iam.gserviceaccount.com"

if ($GcloudConfig) {
  $toolsRoot = Join-Path $repositoryRoot ".tools"
  $resolvedToolsRoot = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $toolsRoot).Path).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $resolvedGcloudConfig = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $GcloudConfig).Path)
  if (-not (Test-Path -LiteralPath $resolvedGcloudConfig -PathType Container)) {
    throw "The gcloud configuration path must be an existing directory."
  }
  if (-not $resolvedGcloudConfig.StartsWith($resolvedToolsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The gcloud configuration path must remain inside the repository's ignored .tools directory."
  }
  $env:CLOUDSDK_CONFIG = $resolvedGcloudConfig
}

# gcloud writes routine notices such as "Updated property [core/project]." to stderr.
# Windows PowerShell turns native stderr into a terminating error while
# $ErrorActionPreference is "Stop", which aborts the deployment on a command that
# actually succeeded, so the exit code is the only failure signal used here.
function Invoke-Gcloud {
  param([Parameter(Mandatory = $true)][string[]]$Command)
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Gcloud @Command
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud command failed: $($Command[0..1] -join ' ')"
  }
}

function Get-GcloudValue {
  param([Parameter(Mandatory = $true)][string[]]$Command)
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $value = & $Gcloud @Command
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud command failed: $($Command[0..1] -join ' ')"
  }
  return $value
}

function Remove-CloudBuildContext {
  param([Parameter(Mandatory = $true)][string]$ContextPath)

  if (-not (Test-Path -LiteralPath $ContextPath)) {
    return
  }

  $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedContext = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $ContextPath).Path)
  if (-not $resolvedContext.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a cloud build context outside the operating-system temporary directory."
  }

  Remove-Item -LiteralPath $resolvedContext -Recurse -Force
}

function New-CloudBuildContext {
  $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $contextPath = Join-Path $temporaryRoot ("belay-cloud-build-" + [guid]::NewGuid().ToString("N"))
  $resolvedContext = [System.IO.Path]::GetFullPath($contextPath)
  if (-not $resolvedContext.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The generated cloud build context escaped the operating-system temporary directory."
  }

  New-Item -ItemType Directory -Path $resolvedContext | Out-Null
  try {
    foreach ($rootFile in @("Dockerfile", "package.json", "package-lock.json", "tsconfig.base.json")) {
      Copy-Item -LiteralPath (Join-Path $repositoryRoot $rootFile) -Destination $resolvedContext
    }

    foreach ($workspaceName in @("contracts", "cloud-service", "dashboard", "daemon")) {
      $sourceWorkspace = Join-Path $repositoryRoot ("packages\" + $workspaceName)
      $targetWorkspace = Join-Path $resolvedContext ("packages\" + $workspaceName)
      New-Item -ItemType Directory -Path $targetWorkspace -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $sourceWorkspace "package.json") -Destination $targetWorkspace

      if ($workspaceName -in @("contracts", "cloud-service")) {
        Copy-Item -LiteralPath (Join-Path $sourceWorkspace "tsconfig.json") -Destination $targetWorkspace
        Copy-Item -LiteralPath (Join-Path $sourceWorkspace "src") -Destination $targetWorkspace -Recurse
      }
    }

    $requiredFiles = @(
      "Dockerfile",
      "package.json",
      "package-lock.json",
      "tsconfig.base.json",
      "packages/contracts/package.json",
      "packages/contracts/tsconfig.json",
      "packages/cloud-service/package.json",
      "packages/cloud-service/tsconfig.json",
      "packages/dashboard/package.json",
      "packages/daemon/package.json"
    )
    $contextPrefix = $resolvedContext.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    $relativeFiles = @(
      Get-ChildItem -LiteralPath $resolvedContext -File -Recurse |
        ForEach-Object {
          $resolvedFile = [System.IO.Path]::GetFullPath($_.FullName)
          if (-not $resolvedFile.StartsWith($contextPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "A cloud build context file escaped the canonical staging root."
          }
          $resolvedFile.Substring($contextPrefix.Length).Replace("\", "/")
        } |
        Sort-Object
    )

    foreach ($requiredFile in $requiredFiles) {
      if ($requiredFile -notin $relativeFiles) {
        throw "The cloud build context is missing required file '$requiredFile'."
      }
    }

    foreach ($relativeFile in $relativeFiles) {
      $isAllowedRootFile = $relativeFile -in @("Dockerfile", "package.json", "package-lock.json", "tsconfig.base.json")
      $isAllowedWorkspaceMetadata = $relativeFile -in @(
        "packages/contracts/package.json",
        "packages/contracts/tsconfig.json",
        "packages/cloud-service/package.json",
        "packages/cloud-service/tsconfig.json",
        "packages/dashboard/package.json",
        "packages/daemon/package.json"
      )
      $isAllowedCloudSource = $relativeFile -match '^packages/(contracts|cloud-service)/src/.+\.ts$'
      if (-not ($isAllowedRootFile -or $isAllowedWorkspaceMetadata -or $isAllowedCloudSource)) {
        throw "Unexpected file in cloud build context: $relativeFile"
      }
    }

    Write-Host "Verified minimal cloud build context ($($relativeFiles.Count) files):"
    $relativeFiles | ForEach-Object { Write-Host "  $_" }
    return $resolvedContext
  } catch {
    Remove-CloudBuildContext -ContextPath $resolvedContext
    throw
  }
}

$cloudBuildContext = New-CloudBuildContext
try {
  if ($ValidateContextOnly) {
    return
  }

  $caller = Get-GcloudValue -Command @("auth", "list", "--filter=status:ACTIVE", "--format=value(account)") | Select-Object -First 1
  if (-not $caller) {
    throw "No active Google Cloud account is available in the selected gcloud configuration."
  }

  $projectStatus = Get-GcloudValue -Command @("projects", "describe", $ProjectId, "--format=value(lifecycleState)") | Select-Object -First 1
  if ($projectStatus -ne "ACTIVE") {
    throw "The selected Google Cloud project is not active."
  }

  Invoke-Gcloud -Command @("config", "set", "project", $ProjectId)
  $configuredProject = Get-GcloudValue -Command @("config", "get-value", "project") | Select-Object -First 1
  if ($configuredProject -ne $ProjectId) {
    throw "The selected gcloud project does not match the requested deployment project."
  }

  Invoke-Gcloud -Command @("services", "enable", "run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "aiplatform.googleapis.com")

  $existingRuntimeAccount = Get-GcloudValue -Command @("iam", "service-accounts", "list", "--filter=email=$runtimeAccount", "--format=value(email)")
  if (-not $existingRuntimeAccount) {
    Invoke-Gcloud -Command @("iam", "service-accounts", "create", $runtimeAccountName, "--display-name=Belay Cloud Intelligence")
  }

  $existingBuilderAccount = Get-GcloudValue -Command @("iam", "service-accounts", "list", "--filter=email=$builderAccount", "--format=value(email)")
  if (-not $existingBuilderAccount) {
    Invoke-Gcloud -Command @("iam", "service-accounts", "create", $builderAccountName, "--display-name=Belay Cloud Builder")
  }

  Invoke-Gcloud -Command @("projects", "add-iam-policy-binding", $ProjectId, "--member=serviceAccount:$runtimeAccount", "--role=roles/aiplatform.user", "--condition=None")
  Invoke-Gcloud -Command @("projects", "add-iam-policy-binding", $ProjectId, "--member=serviceAccount:$builderAccount", "--role=roles/run.builder", "--condition=None")
  Invoke-Gcloud -Command @("iam", "service-accounts", "add-iam-policy-binding", $builderAccount, "--member=user:$caller", "--role=roles/iam.serviceAccountUser", "--condition=None")

  Invoke-Gcloud -Command @(
    "run", "deploy", $ServiceName,
    "--source=$cloudBuildContext",
    "--region=$Region",
    "--service-account=$runtimeAccount",
    "--build-service-account=projects/$ProjectId/serviceAccounts/$builderAccount",
    "--no-allow-unauthenticated",
    "--set-env-vars=BELAY_GEMINI_MODEL=$Model,GCLOUD_LOCATION=global",
    "--quiet"
  )

  $serviceUrl = Get-GcloudValue -Command @("run", "services", "describe", $ServiceName, "--region=$Region", "--format=value(status.url)")
  Invoke-Gcloud -Command @("run", "services", "add-iam-policy-binding", $ServiceName, "--region=$Region", "--member=user:$caller", "--role=roles/run.invoker", "--condition=None", "--quiet")

  $identityToken = Get-GcloudValue -Command @("auth", "print-identity-token")
  $payload = @{
    version = 1
    kind = "manifest_summary"
    projectAlias = "belay-demo"
    manifest = @{
      frameworks = @("typescript", "genkit")
      scripts = @("build", "test")
      ports = @(@{ port = 3420; evidenceType = "config" })
      topology = @(@{ pathHashOrRelativePath = "src/index.ts"; symbolKinds = @("function") })
      git = @{ branch = "main"; dirtyFileCount = 1 }
    }
  } | ConvertTo-Json -Depth 8 -Compress

  $response = Invoke-RestMethod -Method Post -Uri "$serviceUrl/v1/summarize" -Headers @{ Authorization = "Bearer $identityToken" } -ContentType "application/json" -Body $payload

  $fleetPayload = @{
    version = 1
    kind = "fleet_task_decomposition"
    projectAlias = "belay-demo"
    goal = "Refactor authentication to RS256 and add rate limiting before agents execute."
    agents = @("claude-code", "codex", "antigravity")
    manifest = @{
      frameworks = @("typescript", "genkit")
      candidatePaths = @(
        @{ path = "src/auth-service.ts"; symbolKinds = @("class", "function") },
        @{ path = "src/rate-limit.ts"; symbolKinds = @("function") },
        @{ path = "tests/auth.test.ts"; symbolKinds = @("function") }
      )
      git = @{ branch = "main"; dirtyFileCount = 1 }
    }
  } | ConvertTo-Json -Depth 8 -Compress

  $fleetResponse = Invoke-RestMethod -Method Post -Uri "$serviceUrl/v1/decompose-fleet-task" -Headers @{ Authorization = "Bearer $identityToken" } -ContentType "application/json" -Body $fleetPayload

  [pscustomobject]@{
    serviceUrl = $serviceUrl
    requestId = $response.requestId
    model = $response.model
    riskLevel = $response.riskLevel
    generatedAt = $response.generatedAt
    summary = $response.summary
    fleetRequestId = $fleetResponse.requestId
    fleetPlanId = $fleetResponse.planId
    fleetModel = $fleetResponse.model
    fleetTaskCount = $fleetResponse.tasks.Count
    fleetGoalSummary = $fleetResponse.goalSummary
  } | ConvertTo-Json -Depth 4
} finally {
  Remove-CloudBuildContext -ContextPath $cloudBuildContext
}
