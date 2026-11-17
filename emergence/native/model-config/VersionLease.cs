using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Emergence.ModelConfiguration
{
    // OS-held shared file handle is authoritative; PID/start time are diagnostics, never deletion authority.
    sealed class VersionLease : IDisposable
    {
        private FileStream handle;
        private string record;
        internal VersionLease()
        {
            var directory = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (directory != null && !File.Exists(Path.Combine(directory.FullName, "release.json")))
                directory = directory.Parent;
            if (directory == null || directory.Parent == null ||
                !String.Equals(directory.Parent.Name, "versions", StringComparison.OrdinalIgnoreCase) ||
                directory.Parent.Parent == null)
                return;
            var root = directory.Parent.Parent.FullName;
            var marker = Path.Combine(root, "installation.json");
            if (!File.Exists(marker) || Json.Str(Json.Codec.DeserializeObject(File.ReadAllText(marker)), "product") != "emergence")
                return;
            var usage = Path.Combine(root, ".usage");
            for (var parent = new DirectoryInfo(usage); parent != null; parent = parent.Parent)
                if (parent.Exists && (parent.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("安装占用目录包含链接。");
            Directory.CreateDirectory(usage);
            var file = Path.Combine(usage, directory.Name + ".lock");
            if (File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("安装占用文件包含链接。");
            handle = new FileStream(file, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
            try
            {
                using (var process = Process.GetCurrentProcess())
                {
                    var started = process.StartTime.ToUniversalTime().Ticks.ToString();
                    record = Path.Combine(usage, directory.Name + "." + process.Id + "." + started + ".json");
                    if (File.Exists(record) && (File.GetAttributes(record) & FileAttributes.ReparsePoint) != 0)
                        throw new IOException("安装占用记录包含链接。");
                    File.WriteAllText(record, Json.Codec.Serialize(new
                    {
                        directory = directory.Name,
                        pid = process.Id,
                        started = started,
                        kind = "native"
                    }), new UTF8Encoding(false));
                }
            }
            catch { handle.Dispose(); throw; }
        }
        public void Dispose()
        {
            if (handle != null)
                handle.Dispose();
            if (record != null)
            {
                try
                {
                    File.Delete(record);
                }
                catch (IOException) { /* A stale diagnostic is harmless: the OS handle has been released. */ }
                catch (UnauthorizedAccessException) { /* Maintenance leaves unowned records alone. */ }
            }
        }
    }
}
