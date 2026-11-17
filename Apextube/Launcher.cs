using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace ApexTubeLauncher
{
    static class Program
    {
        private static Process serverProcess = null;
        private static NotifyIcon trayIcon = null;

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            Directory.SetCurrentDirectory(appDir);

            // Check if server is already running
            if (!IsServerRunning())
            {
                StartServer(appDir);
            }

            // Wait until server is accessible
            int attempts = 0;
            while (!IsServerRunning() && attempts < 20)
            {
                Thread.Sleep(250);
                attempts++;
            }

            // Open default browser
            try
            {
                Process.Start(new ProcessStartInfo("http://localhost:3000") { UseShellExecute = true });
            }
            catch { }

            // Create System Tray Icon
            trayIcon = new NotifyIcon();
            trayIcon.Text = "ApexTube Playlist Downloader";
            
            // Generate glowing emerald green circular icon
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (SolidBrush darkBrush = new SolidBrush(Color.FromArgb(3, 9, 6)))
                {
                    g.FillRectangle(darkBrush, 0, 0, 32, 32);
                }
                using (Pen neonPen = new Pen(Color.FromArgb(0, 255, 136), 3))
                {
                    g.DrawEllipse(neonPen, 3, 3, 25, 25);
                }
                using (SolidBrush neonBrush = new SolidBrush(Color.FromArgb(0, 255, 136)))
                {
                    Point[] arrow = new Point[] {
                        new Point(16, 22),
                        new Point(10, 14),
                        new Point(22, 14)
                    };
                    g.FillPolygon(neonBrush, arrow);
                    g.FillRectangle(neonBrush, 14, 8, 4, 8);
                }
            }
            trayIcon.Icon = Icon.FromHandle(bmp.GetHicon());
            trayIcon.Visible = true;

            // Context Menu
            ContextMenu contextMenu = new ContextMenu();
            contextMenu.MenuItems.Add("⚡ Open ApexTube (http://localhost:3000)", (s, e) => {
                Process.Start(new ProcessStartInfo("http://localhost:3000") { UseShellExecute = true });
            });
            contextMenu.MenuItems.Add("📂 Open Downloads Folder", (s, e) => {
                string downloads = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
                Process.Start(new ProcessStartInfo("explorer.exe", downloads) { UseShellExecute = true });
            });
            contextMenu.MenuItems.Add("-");
            contextMenu.MenuItems.Add("❌ Exit ApexTube", (s, e) => {
                ExitApp();
            });

            trayIcon.ContextMenu = contextMenu;
            trayIcon.DoubleClick += (s, e) => {
                Process.Start(new ProcessStartInfo("http://localhost:3000") { UseShellExecute = true });
            };

            trayIcon.ShowBalloonTip(3000, "ApexTube Running", "ApexTube Playlist Downloader is live at http://localhost:3000", ToolTipIcon.Info);

            Application.ApplicationExit += (s, e) => ExitApp();
            Application.Run();
        }

        private static bool IsServerRunning()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://localhost:3000/api/default-path");
                request.Timeout = 800;
                request.Method = "GET";
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void StartServer(string appDir)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "node.exe";
                psi.Arguments = "server.js";
                psi.WorkingDirectory = appDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                serverProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not start ApexTube server. Make sure Node.js is installed.\n\nError: " + ex.Message, "ApexTube Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void ExitApp()
        {
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
                trayIcon = null;
            }

            if (serverProcess != null && !serverProcess.HasExited)
            {
                try
                {
                    serverProcess.Kill();
                }
                catch { }
            }

            Environment.Exit(0);
        }
    }
}
