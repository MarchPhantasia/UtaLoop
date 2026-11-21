using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;

namespace UtaLoop.Desktop;

internal sealed class DesktopServices(string dataDirectory) : IDisposable
{
    // Keep this address stable across releases. WebView2 scopes study data to the origin.
    internal static readonly Uri Origin = new("http://127.0.0.1:38596/");
    private readonly string files = AppContext.BaseDirectory;
    private readonly string token = CreateToken();
    private Process? music;
    private Process? site;

    internal async Task StartAsync(CancellationToken closing)
    {
        var musicReady = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var musicInfo = StartInfo("runtime", "node", "node.exe");
        musicInfo.Arguments = QuotePath(Path.Combine(files, "services", "netease", "server.cjs"));
        musicInfo.EnvironmentVariables["UTALOOP_DESKTOP_ROOT"] =
            Directory.GetParent(files.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))!.FullName;
        musicInfo.EnvironmentVariables["UTALOOP_DESKTOP_PRIVATE"] = Path.Combine(dataDirectory, "private");
        musicInfo.EnvironmentVariables.Remove("NODE_OPTIONS");
        musicInfo.EnvironmentVariables.Remove("NODE_PATH");
        music = new Process { StartInfo = musicInfo, EnableRaisingEvents = true };
        music.Exited += (_, _) => musicReady.TrySetException(new IOException("音乐服务提前退出。"));
        music.OutputDataReceived += (_, message) =>
        {
            const string prefix = "UTALOOP_MUSIC_READY ";
            if (message.Data is { } line && line.StartsWith(prefix, StringComparison.Ordinal) &&
                int.TryParse(line.Substring(prefix.Length), out var port) && port is > 0 and < 65536)
                musicReady.TrySetResult(port);
        };
        music.Start();
        Drain(music);
        var timeout = Task.Delay(TimeSpan.FromSeconds(15), closing);
        if (await Task.WhenAny(musicReady.Task, timeout) != musicReady.Task)
        {
            closing.ThrowIfCancellationRequested();
            throw new IOException("音乐服务启动超时。");
        }
        var musicPort = await musicReady.Task;

        var siteInfo = StartInfo("runtime", "python", "python.exe");
        siteInfo.Arguments = "-B " + QuotePath(Path.Combine(files, "serve_desktop.py")) + " " + Origin.Port;
        siteInfo.EnvironmentVariables["UTALOOP_DESKTOP_MUSIC_PORT"] = musicPort.ToString();
        siteInfo.EnvironmentVariables["UTALOOP_DESKTOP_VERSION"] = Program.Version;
        site = Process.Start(siteInfo) ?? throw new IOException("无法启动本地页面服务。");
        Drain(site);
        await WaitForSiteAsync(site, closing);
    }

    private ProcessStartInfo StartInfo(params string[] executable)
    {
        var start = new ProcessStartInfo(Path.Combine(files, Path.Combine(executable)))
        {
            WorkingDirectory = files,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.EnvironmentVariables["UTALOOP_DESKTOP_TOKEN"] = token;
        return start;
    }

    // Both arguments are full paths to files. Windows file names cannot contain quotation marks.
    private static string QuotePath(string value) => "\"" + value + "\"";

    private static string CreateToken()
    {
        var bytes = new byte[32];
        using var generator = RandomNumberGenerator.Create();
        generator.GetBytes(bytes);
        return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }

    private static void Drain(Process process)
    {
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
    }

    private async Task WaitForSiteAsync(Process service, CancellationToken closing)
    {
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(2),
        };
        var elapsed = Stopwatch.StartNew();
        while (elapsed.Elapsed < TimeSpan.FromSeconds(15) && !service.HasExited)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(Origin, "desktop/ready"));
            request.Headers.Add("X-UtaLoop-Ready", token);
            try
            {
                using var result = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, closing);
                if (result.StatusCode == HttpStatusCode.NoContent &&
                    result.Headers.TryGetValues("X-UtaLoop-Desktop-Version", out var versions) &&
                    versions.Contains(Program.Version)) return;
            }
            catch (HttpRequestException) { }
            catch (OperationCanceledException) when (!closing.IsCancellationRequested) { }
            await Task.Delay(150, closing);
        }
        throw new IOException($"本地页面无法启动，请检查端口 {Origin.Port} 是否已被占用。");
    }

    public void Dispose()
    {
        Stop(site);
        Stop(music);
    }

    private static void Stop(Process? process)
    {
        if (process is null) return;
        using (process)
        {
            try
            {
                if (process.HasExited) return;
                process.StandardInput.Close();
                if (!process.WaitForExit(1000)) process.Kill();
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        }
    }
}
