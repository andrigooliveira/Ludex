// Instalador do Ludex com interface própria. É uma janela sem borda que mostra
// ui.html num WebView2 (o motor do Edge que já vem no Windows), com o visual do
// app. A instalação em si é feita pelo instalador NSIS gerado pelo
// electron-builder, que vai grudado no fim deste executável e roda em silêncio.
// Montado por scripts/setup/build-setup.js; compilado com o csc do .NET Framework.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Instalador do Ludex")]
[assembly: AssemblyProduct("Ludex")]

static class Program
{
    public static string TempDir;

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool SetDllDirectory(string path);

    [STAThread]
    static int Main(string[] args)
    {
        // Nítido em telas com escala (125%, 150%...).
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); }

        TempDir = Path.Combine(Path.GetTempPath(), "ludex-setup-" + Process.GetCurrentProcess().Id);
        Directory.CreateDirectory(TempDir);

        // As DLLs do WebView2 vão dentro deste executável: a nativa é extraída, as
        // gerenciadas são carregadas direto da memória quando o .NET pedir.
        File.WriteAllBytes(Path.Combine(TempDir, "WebView2Loader.dll"), Resource("WebView2Loader.dll"));
        SetDllDirectory(TempDir);
        AppDomain.CurrentDomain.AssemblyResolve += (sender, e) =>
        {
            string name = new AssemblyName(e.Name).Name + ".dll";
            byte[] bytes = Resource(name);
            return bytes == null ? null : Assembly.Load(bytes);
        };

        string installer;
        try { installer = ExtractPayload(); }
        catch (Exception error)
        {
            MessageBox.Show("Este instalador está incompleto ou corrompido. Baixe-o de novo.\n\n" + error.Message, "Ludex", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        int code = Launcher.Run(installer);
        try { Directory.Delete(TempDir, true); } catch { }
        return code;
    }

    public static byte[] Resource(string name)
    {
        using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        {
            if (stream == null) return null;
            byte[] bytes = new byte[stream.Length];
            int read = 0;
            while (read < bytes.Length) read += stream.Read(bytes, read, bytes.Length - read);
            return bytes;
        }
    }

    // O instalador NSIS fica no fim do arquivo: [exe][instalador][tamanho: 8 bytes]["LUDEXPAY"].
    static string ExtractPayload()
    {
        string self = Assembly.GetExecutingAssembly().Location;
        using (FileStream file = File.OpenRead(self))
        {
            byte[] trailer = new byte[16];
            file.Seek(-16, SeekOrigin.End);
            file.Read(trailer, 0, 16);
            if (Encoding.ASCII.GetString(trailer, 8, 8) != "LUDEXPAY") throw new InvalidDataException("sem instalador embutido");
            long length = BitConverter.ToInt64(trailer, 0);
            file.Seek(-16 - length, SeekOrigin.End);
            string target = Path.Combine(TempDir, "ludex-instalador.exe");
            using (FileStream output = File.Create(target))
            {
                byte[] buffer = new byte[1 << 20];
                long left = length;
                while (left > 0)
                {
                    int read = file.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                    if (read <= 0) throw new EndOfStreamException();
                    output.Write(buffer, 0, read);
                    left -= read;
                }
            }
            return target;
        }
    }
}

// Separado de Program para os tipos do WebView2 só serem carregados depois que o
// AssemblyResolve estiver ligado.
static class Launcher
{
    public static int Run(string installer)
    {
        // Sem o WebView2 no sistema (raro no Windows 10/11): abre o instalador comum.
        try { Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch
        {
            Process process = Process.Start(installer);
            process.WaitForExit();
            return process.ExitCode;
        }
        SetupForm form = new SetupForm(installer);
        Application.Run(form);
        return 0;
    }
}

class SetupForm : Form
{
    readonly string installer;
    readonly Microsoft.Web.WebView2.WinForms.WebView2 view;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Dictionary<string, object> config;
    readonly string product;        // "Ludex": nome da pasta e do executável
    readonly List<string> names;    // nomes do app, o atual e os antigos ("Game Launcher")
    bool installing;

    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr w, IntPtr l);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    public SetupForm(string installer)
    {
        this.installer = installer;
        config = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Program.Resource("config.json")));
        product = (string)config["product"];
        names = new List<string> { product };
        foreach (object legacy in (System.Collections.ArrayList)config["legacy"]) names.Add((string)legacy);
        Text = "Instalar o Ludex";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(10, 10, 10);
        try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
        float scale = DeviceDpi / 96f;
        ClientSize = new Size((int)(880 * scale), (int)(560 * scale));

        view = new Microsoft.Web.WebView2.WinForms.WebView2();
        view.Dock = DockStyle.Fill;
        view.DefaultBackgroundColor = Color.FromArgb(10, 10, 10);
        Controls.Add(view);
        Load += async (sender, e) => await Start();
    }

    // Janela sem borda, mas com a sombra do Windows e cantos retos (como o app).
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
            cp.Style |= 0x20000;      // WS_MINIMIZEBOX: minimizar pela barra de tarefas
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int square = 1; // DWMWCP_DONOTROUND
        try { DwmSetWindowAttribute(Handle, 33, ref square, 4); } catch { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // No meio da instalação, fechar deixaria tudo pela metade.
        if (installing && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
        base.OnFormClosing(e);
    }

    async Task Start()
    {
        // A pasta de dados do WebView2 vai para a pasta temporária (a do executável pode não aceitar escrita).
        var environment = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.TempDir, "webview"));
        await view.EnsureCoreWebView2Async(environment);
        var settings = view.CoreWebView2.Settings;
        settings.AreDefaultContextMenusEnabled = false;
        settings.AreDevToolsEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;
        view.CoreWebView2.WebMessageReceived += (sender, e) => OnMessage(e.TryGetWebMessageAsString());
        view.CoreWebView2.NavigateToString(Encoding.UTF8.GetString(Program.Resource("ui.html")));
    }

    void Send(object message)
    {
        string text = json.Serialize(message);
        if (InvokeRequired) BeginInvoke(new Action(() => view.CoreWebView2.PostWebMessageAsJson(text)));
        else view.CoreWebView2.PostWebMessageAsJson(text);
    }

    void OnMessage(string raw)
    {
        var message = json.Deserialize<Dictionary<string, object>>(raw);
        string type = (string)message["type"];
        if (type == "ready") SendInit();
        else if (type == "drag") { ReleaseCapture(); SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); }
        else if (type == "minimize") WindowState = FormWindowState.Minimized;
        else if (type == "close") Close();
        else if (type == "pickDir") PickDir((string)message["dir"]);
        else if (type == "dirInfo") Send(DirInfo((string)message["dir"]));
        else if (type == "install") Install((string)message["dir"], (bool)message["desktop"], (bool)message["startMenu"], (bool)message["closeRunning"]);
        else if (type == "finish")
        {
            if ((bool)message["launch"]) StartApp((string)message["dir"]);
            Close();
        }
    }

    // ---------- Pasta e espaço em disco ----------

    // Instalação anterior (Ludex ou o antigo Game Launcher), pela lista de "Aplicativos instalados".
    string ExistingInstall()
    {
        using (RegistryKey uninstall = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
        {
            if (uninstall == null) return null;
            foreach (string name in uninstall.GetSubKeyNames())
            {
                using (RegistryKey key = uninstall.OpenSubKey(name))
                {
                    string display = key == null ? null : key.GetValue("DisplayName") as string;
                    if (display == null || !names.Exists(n => display == n || display.StartsWith(n + " "))) continue;
                    string location = key.GetValue("InstallLocation") as string;
                    if (string.IsNullOrEmpty(location))
                    {
                        string uninstallString = (key.GetValue("UninstallString") as string ?? "").Trim('"');
                        int quote = uninstallString.IndexOf('"');
                        if (quote > 0) uninstallString = uninstallString.Substring(0, quote);
                        if (uninstallString.Length > 0) location = Path.GetDirectoryName(uninstallString);
                    }
                    if (!string.IsNullOrEmpty(location) && Directory.Exists(location)) return location;
                }
            }
        }
        return null;
    }

    // A pasta sempre termina em "Ludex" (escolher D:\Jogos instala em D:\Jogos\Ludex).
    string Normalize(string dir)
    {
        dir = dir.Trim().TrimEnd('\\', '/');
        if (!Path.GetFileName(dir).Equals(product, StringComparison.OrdinalIgnoreCase)) dir = Path.Combine(dir, product);
        return dir;
    }

    object DirInfo(string dir)
    {
        long free = -1;
        string drive = "";
        try
        {
            DriveInfo info = new DriveInfo(Path.GetPathRoot(dir));
            drive = info.Name.TrimEnd('\\');
            free = info.AvailableFreeSpace;
        }
        catch { }
        return new Dictionary<string, object> { { "type", "dir" }, { "dir", dir }, { "free", free }, { "drive", drive }, { "writable", Writable(dir) } };
    }

    // Dá para gravar na pasta (ou na primeira pasta existente acima dela)?
    static bool Writable(string dir)
    {
        string probe = dir;
        while (!string.IsNullOrEmpty(probe) && !Directory.Exists(probe)) probe = Path.GetDirectoryName(probe);
        if (string.IsNullOrEmpty(probe)) return false;
        try
        {
            string test = Path.Combine(probe, ".ludex-teste-" + Guid.NewGuid().ToString("N"));
            File.WriteAllText(test, "");
            File.Delete(test);
            return true;
        }
        catch { return false; }
    }

    void SendInit()
    {
        string existing = ExistingInstall();
        string dir = existing != null ? Normalize(existing) : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", product);
        var info = (Dictionary<string, object>)DirInfo(dir);
        info["type"] = "init";
        info["version"] = config["version"];
        info["required"] = config["requiredBytes"];
        info["upgrade"] = existing != null;
        Send(info);
    }

    void PickDir(string current)
    {
        string picked = FolderPicker.Pick(Handle, "Pasta de instalação do Ludex", Path.GetDirectoryName(current));
        if (picked != null) Send(DirInfo(Normalize(picked)));
    }

    // ---------- Instalação ----------

    Process[] RunningApp()
    {
        var list = new List<Process>();
        foreach (string name in names) list.AddRange(Process.GetProcessesByName(name));
        return list.ToArray();
    }

    void Install(string dir, bool desktop, bool startMenu, bool closeRunning)
    {
        Process[] running = RunningApp();
        if (running.Length > 0 && !closeRunning)
        {
            Send(new Dictionary<string, object> { { "type", "running" } });
            return;
        }
        installing = true;
        new Thread(() =>
        {
            try
            {
                foreach (Process process in running)
                {
                    try { process.Kill(); process.WaitForExit(5000); } catch { }
                }
                // /D precisa ser o último argumento e sem aspas (regra do NSIS).
                string arguments = "/S /currentuser" + (desktop ? "" : " --no-desktop-shortcut") + (startMenu ? "" : " --no-start-menu-shortcut") + " /D=" + dir;
                Process setup = Process.Start(new ProcessStartInfo(installer, arguments) { UseShellExecute = false });
                long required = Convert.ToInt64(config["requiredBytes"]);
                while (!setup.WaitForExit(400))
                {
                    double done = Math.Min(0.98, FolderSize(dir) / (double)Math.Max(1, required));
                    Send(new Dictionary<string, object> { { "type", "progress" }, { "value", done } });
                }
                installing = false;
                if (setup.ExitCode == 0 && File.Exists(Path.Combine(dir, product + ".exe")))
                    Send(new Dictionary<string, object> { { "type", "done" }, { "dir", dir } });
                else
                    Send(new Dictionary<string, object> { { "type", "error" }, { "message", "A instalação não terminou (código " + setup.ExitCode + "). Confira se há espaço e permissão na pasta escolhida e tente de novo." } });
            }
            catch (Exception error)
            {
                installing = false;
                Send(new Dictionary<string, object> { { "type", "error" }, { "message", error.Message } });
            }
        }) { IsBackground = true }.Start();
    }

    static long FolderSize(string dir)
    {
        long total = 0;
        try
        {
            foreach (string file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                try { total += new FileInfo(file).Length; } catch { }
            }
        }
        catch { }
        return total;
    }

    void StartApp(string dir)
    {
        try { Process.Start(new ProcessStartInfo(Path.Combine(dir, product + ".exe")) { WorkingDirectory = dir, UseShellExecute = true }); } catch { }
    }
}

// Seletor de pasta moderno do Windows (o mesmo do Explorador), pela interface COM IFileOpenDialog.
static class FolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr specs);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem item);
        void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);

    public static string Pick(IntPtr owner, string title, string start)
    {
        IFileDialog dialog = (IFileDialog)new FileOpenDialogRCW();
        dialog.SetOptions(0x20 | 0x40 | 0x800); // pastas, só do sistema de arquivos, caminho precisa existir
        dialog.SetTitle(title);
        dialog.SetOkButtonLabel("Escolher esta pasta");
        try
        {
            Guid shellItem = typeof(IShellItem).GUID;
            IShellItem folder;
            if (!string.IsNullOrEmpty(start) && Directory.Exists(start))
            {
                SHCreateItemFromParsingName(start, IntPtr.Zero, ref shellItem, out folder);
                dialog.SetFolder(folder);
            }
        }
        catch { }
        if (dialog.Show(owner) != 0) return null;
        IShellItem result;
        dialog.GetResult(out result);
        string path;
        result.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
        return path;
    }
}
