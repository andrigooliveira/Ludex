// Executável pequeno que fica na raiz da pasta de instalação e abre o launcher
// de verdade, que mora em app\ com todos os arquivos do Electron. Compilado por
// scripts/after-sign.js com o csc do .NET Framework (já vem no Windows).
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

[assembly: AssemblyTitle("Ludex")]
[assembly: AssemblyProduct("Ludex")]

static class Launcher
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr owner, string text, string caption, uint type);

    [STAThread]
    static int Main(string[] args)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        string folder = Path.Combine(Path.GetDirectoryName(self), "app");
        string target = Path.Combine(folder, Path.GetFileName(self));

        // Repassa os argumentos como vieram.
        StringBuilder line = new StringBuilder();
        foreach (string arg in args)
        {
            if (line.Length > 0) line.Append(' ');
            line.Append('"').Append(arg.Replace("\"", "\\\"")).Append('"');
        }

        try
        {
            ProcessStartInfo info = new ProcessStartInfo(target, line.ToString());
            info.WorkingDirectory = folder;
            info.UseShellExecute = false;
            Process.Start(info);
            return 0;
        }
        catch (Exception error)
        {
            MessageBoxW(IntPtr.Zero, "Não foi possível abrir o Ludex.\n\n" + target + "\n\n" + error.Message, "Ludex", 0x10);
            return 1;
        }
    }
}
