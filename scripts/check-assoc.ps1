# Print the handlers Windows would actually offer for an extension.
#
# Why this is not just a registry read: the "Open with" list is assembled by the shell
# from several places (the class default, OpenWithProgids, Software\Classes\Applications,
# registered-application capabilities, and per-user MRU). Confirming that a ProgId key
# exists proves nothing about whether the app appears in that dialog — which is the only
# thing a user can act on. SHAssocEnumHandlers is the same API the shell itself uses.
#
#   powershell -ExecutionPolicy Bypass -File scripts/check-assoc.ps1 .md
#
# The enumeration runs inside the C# block rather than in PowerShell: the interface
# pointer comes back to PowerShell as a plain __ComObject whose methods its adapter
# cannot see.

param([string]$Extension = '.md')

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("F04061AC-1659-4a3f-A954-775AA57FC083"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAssocHandler {
  [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
  [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
  [PreserveSig] int GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string ppszPath, out int pIndex);
  [PreserveSig] int IsRecommended();
  [PreserveSig] int MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
  [PreserveSig] int Invoke(IntPtr pdo);
  [PreserveSig] int CreateInvoker(IntPtr pdo, out IntPtr ppInvoker);
}

[ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IEnumAssocHandlers {
  [PreserveSig] int Next(uint celt,
    [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.Interface, SizeParamIndex = 0)]
    IAssocHandler[] rgelt, out uint pceltFetched);
}

public static class Assoc {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHAssocEnumHandlers(string pszExtra, int afFilter,
    out IEnumAssocHandlers ppEnumHandler);

  public static string[] List(string ext) {
    IEnumAssocHandlers e;
    SHAssocEnumHandlers(ext, 0, out e);      // 0 = ASSOC_FILTER_NONE
    var rows = new List<string>();
    var one = new IAssocHandler[1];
    uint got;
    // Bounded: a corrupt enumerator must not spin forever.
    for (int i = 0; i < 200; i++) {
      if (e.Next(1, one, out got) != 0 || got == 0) break;
      string ui, path;
      one[0].GetUIName(out ui);
      one[0].GetName(out path);
      bool rec = one[0].IsRecommended() == 0;
      rows.Add((ui ?? "?").PadRight(26) + (rec ? "recommended  " : "other        ") + (path ?? ""));
      Marshal.ReleaseComObject(one[0]);
    }
    return rows.ToArray();
  }
}
'@ -ErrorAction Stop

$rows = [Assoc]::List($Extension)
Write-Output "Handlers Windows offers for $Extension :"
$rows | ForEach-Object { Write-Output "  $_" }
Write-Output "$($rows.Count) handler(s)."

if ($rows -match 'blockmd') {
  Write-Output 'BlockMD: PRESENT in the Open with list.'
} else {
  Write-Output 'BlockMD: ABSENT from the Open with list.'
}
