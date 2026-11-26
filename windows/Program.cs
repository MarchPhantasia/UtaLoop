using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace UtaLoop.Desktop;

internal static class Program
{
    internal const string MutexName = @"Local\UtaLoop.Windows.Desktop";

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var instance = new Mutex(false, MutexName, out var first);
        if (!first)
        {
            MessageBox.Show("UtaLoop 已打开，或安装程序正在运行。", "UtaLoop");
            return;
        }

        try
        {
            var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            var configuredData = Environment.GetEnvironmentVariable("UTALOOP_DESKTOP_DATA_DIRECTORY");
            var data = configuredData ?? Path.Combine(documents, "UtaLoop");
            if (Path.GetPathRoot(data) is not { Length: >= 3 })
                throw new IOException("无法定位 Windows 文档目录。");

            using var services = new DesktopServices(data);
            using var window = new DesktopWindow(services, Path.Combine(data, "profile"));
            Application.Run(window);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "UtaLoop 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}

internal sealed class DesktopWindow : Form
{
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Label status = new()
    {
        Text = "正在打开 UtaLoop…",
        TextAlign = ContentAlignment.MiddleCenter,
        Dock = DockStyle.Fill,
        Padding = new Padding(28),
    };
    private readonly CancellationTokenSource closing = new();

    public DesktopWindow(DesktopServices services, string profile)
    {
        Text = "UtaLoop";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1180, 820);
        MinimumSize = new Size(520, 620);
        BackColor = Color.FromArgb(246, 247, 243);
        Font = new Font("Microsoft YaHei UI", 11);
        Controls.Add(browser);
        Controls.Add(status);

        Shown += async (_, _) =>
        {
            try
            {
                Directory.CreateDirectory(profile);
                // Keep WebView2 audio in its browser process for OBS process-loopback capture.
                var options = new CoreWebView2EnvironmentOptions("--disable-features=AudioServiceOutOfProcess");
                var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile, options: options);
                await browser.EnsureCoreWebView2Async(environment);
                await services.StartAsync(closing.Token);
                if (IsDisposed) return;
                ConfigureBrowser();
                browser.Visible = true;
                status.Visible = false;
                browser.Source = DesktopServices.Origin;
                await services.SiteStopped;
                if (IsDisposed || closing.IsCancellationRequested) return;
                browser.Dispose();
                status.Text = "UtaLoop 本地页面服务已退出。\n\n关闭窗口后可重新尝试。";
                status.Visible = true;
            }
            catch (Exception error) when (!IsDisposed && !closing.IsCancellationRequested)
            {
                status.Text = error is WebView2RuntimeNotFoundException
                    ? "请安装 Microsoft Edge WebView2 Runtime，然后重新打开 UtaLoop。"
                    : $"UtaLoop 无法启动\n{error.Message}\n\n关闭窗口后可重新尝试。";
            }
            catch (Exception) when (IsDisposed || closing.IsCancellationRequested) { }
        };
        FormClosed += (_, _) =>
        {
            closing.Cancel();
            closing.Dispose();
        };
    }

    private void ConfigureBrowser()
    {
        var web = browser.CoreWebView2;
        web.Settings.AreHostObjectsAllowed = false;
        web.Settings.IsWebMessageEnabled = false;
        web.Settings.AreDevToolsEnabled = false;
        web.NavigationStarting += (_, request) =>
        {
            if (IsAppUrl(request.Uri)) return;
            request.Cancel = true;
            if (request.IsUserInitiated) OpenExternal(request.Uri);
        };
        web.NewWindowRequested += (_, request) =>
        {
            request.Handled = true;
            if (!request.IsUserInitiated) return;
            if (IsAppUrl(request.Uri)) web.Navigate(request.Uri);
            else OpenExternal(request.Uri);
        };
    }

    private static bool IsAppUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.GetLeftPart(UriPartial.Authority) == DesktopServices.Origin.GetLeftPart(UriPartial.Authority);

    private static void OpenExternal(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true })?.Dispose(); }
        catch (System.ComponentModel.Win32Exception) { }
    }
}
