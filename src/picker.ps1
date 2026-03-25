Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    [PreserveSig] int SetFileTypes(uint n, IntPtr p);
    [PreserveSig] int SetFileTypeIndex(uint i);
    [PreserveSig] int GetFileTypeIndex(out uint i);
    [PreserveSig] int Advise(IntPtr p, out uint c);
    [PreserveSig] int Unadvise(uint c);
    [PreserveSig] int SetOptions(uint f);
    [PreserveSig] int GetOptions(out uint f);
    [PreserveSig] int SetDefaultFolder(IShellItemX p);
    [PreserveSig] int SetFolder(IShellItemX p);
    [PreserveSig] int GetFolder(out IShellItemX p);
    [PreserveSig] int GetCurrentSelection(out IShellItemX p);
    [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string s);
    [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int GetResult(out IShellItemX p);
    [PreserveSig] int AddPlace(IShellItemX p, int a);
    [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string s);
    [PreserveSig] int Close(int h);
    [PreserveSig] int SetClientGuid(ref Guid g);
    [PreserveSig] int ClearClientData();
    [PreserveSig] int SetFilter(IntPtr p);
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItemX {
    [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetParent(out IShellItemX ppsi);
    [PreserveSig] int GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int GetAttributes(uint mask, out uint attrs);
    [PreserveSig] int Compare(IShellItemX psi, uint hint, out int order);
}

public static class FolderPicker {
    // CLSID_FileOpenDialog
    private static readonly Guid ClsidFileOpenDialog =
        new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");

    public static string Pick() {
        // CoCreateInstance inside C# — COM casting works correctly here
        var type   = Type.GetTypeFromCLSID(ClsidFileOpenDialog);
        var obj    = Activator.CreateInstance(type);
        var dialog = (IFileDialog)obj;

        // FOS_PICKFOLDERS (0x20) | FOS_FORCEFILESYSTEM (0x40)
        dialog.SetOptions(0x60u);

        // S_OK = 0; HRESULT_FROM_WIN32(ERROR_CANCELLED) = 0x800704C7
        int hr = dialog.Show(IntPtr.Zero);
        if (hr != 0) return null;

        IShellItemX item;
        dialog.GetResult(out item);

        string path;
        // SIGDN_FILESYSPATH = 0x80058000
        item.GetDisplayName(0x80058000u, out path);
        return path;
    }
}
"@

$result = [FolderPicker]::Pick()
if ($result) { Write-Output $result }
