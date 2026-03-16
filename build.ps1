$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$outName = 'DynamicsAudioCompanion-v' + $version

Write-Host ''
Write-Host '  Dynamics Audio Companion - Build Package v' -NoNewline -ForegroundColor Cyan
Write-Host $version -ForegroundColor Cyan
Write-Host ''

# ── Step 1: Compile native host to standalone .exe (Node.js SEA) ──
Write-Host '  [1/4] Compiling native host to standalone .exe ...' -ForegroundColor Yellow
$nhDir = Join-Path $root 'native-host'

# Ensure dependencies are installed (build machine only)
if (-not (Test-Path (Join-Path $nhDir 'node_modules'))) {
    Write-Host '    Installing dependencies...' -ForegroundColor Gray
    Push-Location $nhDir
    npm install 2>$null | Out-Null
    Pop-Location
}

# Step 1a: Bundle JS into a single file
Push-Location $nhDir
Write-Host '    Bundling with esbuild...' -ForegroundColor Gray
npx esbuild host.js --bundle --platform=node --outfile=host-bundle.js 2>$null
if (-not (Test-Path (Join-Path $nhDir 'host-bundle.js'))) {
    Write-Host '    ERROR: esbuild bundling failed' -ForegroundColor Red
    Pop-Location
    exit 1
}

# Step 1b: Generate SEA blob
Write-Host '    Generating SEA blob...' -ForegroundColor Gray
node --experimental-sea-config sea-config.json 2>$null
if (-not (Test-Path (Join-Path $nhDir 'sea-prep.blob'))) {
    Write-Host '    ERROR: SEA blob generation failed' -ForegroundColor Red
    Pop-Location
    exit 1
}

# Step 1c: Copy node.exe and inject the blob
Write-Host '    Creating standalone exe...' -ForegroundColor Gray
$exePath = Join-Path $nhDir 'dynamics-audio-companion.exe'
if (Test-Path $exePath) { Remove-Item $exePath -Force }
Copy-Item (Get-Command node).Source $exePath

# Remove the signature so postject can modify the exe
$ErrorActionPreference = 'SilentlyContinue'
& signtool remove /s $exePath 2>$null
$ErrorActionPreference = 'Stop'

npx postject $exePath NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite 2>$null

# Clean up intermediate files
Remove-Item (Join-Path $nhDir 'host-bundle.js') -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $nhDir 'sea-prep.blob') -Force -ErrorAction SilentlyContinue

Pop-Location

if (-not (Test-Path $exePath)) {
    Write-Host '    ERROR: SEA compilation failed' -ForegroundColor Red
    exit 1
}
$exeKB = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
Write-Host "    dynamics-audio-companion.exe compiled ($exeKB MB)" -ForegroundColor Green

# ── Step 2: Stage files ──
Write-Host '  [2/4] Staging files...' -ForegroundColor Yellow

$outDir = Join-Path $root 'dist'
$stageDir = Join-Path $outDir $outName
$zipPath = Join-Path $outDir ($outName + '.zip')
$setupExePath = Join-Path $outDir ($outName + '-Setup.exe')

if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (Test-Path $setupExePath) { Remove-Item $setupExePath -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

# Copy extension files
foreach ($f in @('manifest.json', 'README.md', 'install.ps1')) {
    $src = Join-Path $root $f
    if (Test-Path $src) { Copy-Item $src $stageDir }
}

# Copy extension source directories
foreach ($d in @('src', 'icons', 'scripts')) {
    $src = Join-Path $root $d
    if (Test-Path $src) { Copy-Item $src (Join-Path $stageDir $d) -Recurse }
}

# Copy native host (compiled exe + WinKeyServer.exe only, no source/node_modules)
$nhDest = Join-Path $stageDir 'native-host'
New-Item -ItemType Directory -Path $nhDest -Force | Out-Null

# Copy compiled exe
Copy-Item (Join-Path $nhDir 'dynamics-audio-companion.exe') $nhDest

# Copy WinKeyServer.exe (required by node-global-key-listener at runtime)
$wksPath = Get-ChildItem (Join-Path $nhDir 'node_modules') -Recurse -Filter 'WinKeyServer.exe' | Select-Object -First 1
if ($wksPath) {
    Copy-Item $wksPath.FullName $nhDest
    Write-Host '    WinKeyServer.exe included' -ForegroundColor Green
} else {
    Write-Host '    WARNING: WinKeyServer.exe not found!' -ForegroundColor Red
}

# Copy install scripts and manifest template
foreach ($f in @('install.bat', 'native-manifest.json')) {
    $src = Join-Path $root ('native-host\' + $f)
    if (Test-Path $src) { Copy-Item $src $nhDest }
}

# ── Step 3: Create intermediate zip ──
Write-Host '  [3/4] Creating intermediate zip...' -ForegroundColor Yellow
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -Force

# Clean staging directory (no longer needed)
Remove-Item $stageDir -Recurse -Force

# ── Step 4: Create self-extracting installer .exe ──
Write-Host '  [4/4] Creating self-extracting installer .exe ...' -ForegroundColor Yellow

# Compile a small C# stub that reads the zip appended to itself and extracts it
$stubSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;

class SelfExtractor {
    static int Main() {
        Console.WriteLine();
        Console.WriteLine("  ================================================================");
        Console.WriteLine("   Dynamics Audio Companion - Self-Extracting Installer");
        Console.WriteLine("  ================================================================");
        Console.WriteLine();

        string installDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DynamicsAudioCompanion");

        Console.WriteLine("  Install location: " + installDir);
        Console.WriteLine();

        try {
            string exePath = Process.GetCurrentProcess().MainModule.FileName;

            // Last 8 bytes of this exe contain the offset where the zip data starts
            byte[] allBytes = File.ReadAllBytes(exePath);
            long zipOffset = BitConverter.ToInt64(allBytes, allBytes.Length - 8);

            // Extract zip portion to a temp file
            string tempZip = Path.Combine(Path.GetTempPath(), "DynamicsAudioCompanion_pkg.zip");
            int zipLen = allBytes.Length - (int)zipOffset - 8;
            using (var fs = new FileStream(tempZip, FileMode.Create))
                fs.Write(allBytes, (int)zipOffset, zipLen);

            Console.WriteLine("  Extracting files...");

            // Clear and extract
            if (Directory.Exists(installDir))
                Directory.Delete(installDir, true);
            ZipFile.ExtractToDirectory(tempZip, installDir);

            // Clean temp zip
            try { File.Delete(tempZip); } catch { }

            Console.WriteLine("  Files extracted successfully.");
            Console.WriteLine();

            // Run install.ps1 from the extracted location
            string installScript = Path.Combine(installDir, "install.ps1");
            if (File.Exists(installScript)) {
                var psi = new ProcessStartInfo {
                    FileName = "powershell.exe",
                    Arguments = "-ExecutionPolicy Bypass -File \"" + installScript + "\"",
                    UseShellExecute = false
                };
                var p = Process.Start(psi);
                p.WaitForExit();
                return p.ExitCode;
            } else {
                Console.WriteLine("  WARNING: install.ps1 not found in extracted files.");
                Console.WriteLine("  Files have been extracted to: " + installDir);
                Console.WriteLine("  Press Enter to close.");
                Console.ReadLine();
                return 1;
            }
        } catch (Exception ex) {
            Console.WriteLine("  ERROR: " + ex.Message);
            Console.WriteLine();
            Console.WriteLine("  Press Enter to close.");
            Console.ReadLine();
            return 1;
        }
    }
}
'@

$stubExePath = Join-Path $outDir 'stub.exe'

# Compile the C# stub
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -TypeDefinition $stubSource `
    -OutputAssembly $stubExePath `
    -OutputType ConsoleApplication `
    -ReferencedAssemblies @(
        'System.IO.Compression.dll',
        'System.IO.Compression.FileSystem.dll'
    )

if (-not (Test-Path $stubExePath)) {
    throw 'C# stub compilation failed'
}
Write-Host '    Stub compiled' -ForegroundColor Green

# Build the self-extracting exe: [stub.exe bytes][zip bytes][8-byte zip offset]
$stubBytes = [System.IO.File]::ReadAllBytes($stubExePath)
$zipBytes  = [System.IO.File]::ReadAllBytes($zipPath)
$zipOffset = [BitConverter]::GetBytes([long]$stubBytes.Length)

$fs = [System.IO.File]::Create($setupExePath)
$fs.Write($stubBytes, 0, $stubBytes.Length)
$fs.Write($zipBytes, 0, $zipBytes.Length)
$fs.Write($zipOffset, 0, $zipOffset.Length)
$fs.Close()

# Clean up stub
Remove-Item $stubExePath -Force

if (Test-Path $setupExePath) {
    $exeMB = [math]::Round((Get-Item $setupExePath).Length / 1MB, 1)
    $zipKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)

    Write-Host ''
    Write-Host '  BUILD COMPLETE' -ForegroundColor Green
    Write-Host ('  Installer: ' + $setupExePath + ' (' + $exeMB + ' MB)') -ForegroundColor Green
    Write-Host ('  Zip also:  ' + $zipPath + ' (' + $zipKB + ' KB)') -ForegroundColor Green
    Write-Host ''
    Write-Host '  To install on another computer:' -ForegroundColor Gray
    Write-Host '    Option A: Send the .exe, double-click it' -ForegroundColor Gray
    Write-Host '    Option B: Send the .zip, extract, run install.ps1' -ForegroundColor Gray
    Write-Host '    NO Node.js required!' -ForegroundColor Cyan
    Write-Host ''
} else {
    Write-Host ''
    Write-Host '  WARNING: Self-extracting exe creation failed' -ForegroundColor Red
    Write-Host '  The .zip package is still available:' -ForegroundColor Yellow
    $zipKB = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Host ('  ' + $zipPath + ' (' + $zipKB + ' KB)') -ForegroundColor Yellow
    Write-Host ''
}

# Clean up temp files
if (Test-Path (Join-Path $outDir 'iex-stage')) { Remove-Item (Join-Path $outDir 'iex-stage') -Recurse -Force }
if (Test-Path (Join-Path $outDir 'installer.sed')) { Remove-Item (Join-Path $outDir 'installer.sed') -Force }
