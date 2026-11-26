using System.Diagnostics;
using System.Net.Sockets;
using System.Security.Cryptography;

namespace UtaLoop.Desktop;

internal sealed class DesktopServices(string dataDirectory) : IDisposable
{
    // Keep this address stable across releases. WebView2 scopes study data to the origin.
    internal static readonly Uri Origin = new("http://127.0.0.1:38596/");
    private readonly string files = AppContext.BaseDirectory;
    private readonly string token = CreateToken();
    private readonly TaskCompletionSource<bool> siteStopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Process? music;
    private Process? site;
    private Socket? siteListener;

    internal Task SiteStopped => siteStopped.Task;

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
        var musicPort = await WaitForReadyAsync(musicReady.Task, "音乐服务启动超时。", closing);

        var siteReady = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var siteInfo = StartInfo("runtime", "python", "python.exe");
        siteInfo.Arguments = "-B " + QuotePath(Path.Combine(files, "serve_desktop.py")) + " " + Origin.Port;
        siteInfo.EnvironmentVariables["UTALOOP_DESKTOP_MUSIC_PORT"] = musicPort.ToString();
        site = new Process { StartInfo = siteInfo, EnableRaisingEvents = true };
        var siteError = $"本地页面无法启动，请检查端口 {Origin.Port} 是否已被占用。";
        site.Exited += (_, _) =>
        {
            siteReady.TrySetException(new IOException(siteError));
            siteStopped.TrySetResult(true);
        };
        site.OutputDataReceived += (_, message) =>
        {
            const string prefix = "UTALOOP_SITE_READY ";
            if (message.Data is { } line && line.StartsWith(prefix, StringComparison.Ordinal))
                siteReady.TrySetResult(line.Substring(prefix.Length));
        };
        site.Start();
        Drain(site);
        var listener = await WaitForReadyAsync(siteReady.Task, siteError, closing);
        // Retain the exclusive listener even if Python exits while the WebView is still open.
        siteListener = new Socket(new SocketInformation
        {
            ProtocolInformation = Convert.FromBase64String(listener),
            Options = SocketInformationOptions.Listening,
        });
        if (site.HasExited) throw new IOException(siteError);
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

    private static async Task<T> WaitForReadyAsync<T>(Task<T> ready, string timeoutMessage, CancellationToken closing)
    {
        var finished = await Task.WhenAny(ready, Task.Delay(TimeSpan.FromSeconds(15), closing));
        closing.ThrowIfCancellationRequested();
        if (finished != ready) throw new IOException(timeoutMessage);
        return await ready;
    }

    public void Dispose()
    {
        Stop(site);
        Stop(music);
        siteListener?.Dispose();
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
