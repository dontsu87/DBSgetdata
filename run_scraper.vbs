Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get directory of this VBScript file
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Set environment variables directly in the script process
Set env = ws.Environment("Process")
env("PYTHONIOENCODING") = "utf-8"

' Build paths to pythonw (no-window version) inside virtualenv and python scripts
pyPath = scriptDir & "\.venv\Scripts\pythonw.exe"
mainPath = scriptDir & "\main.py"
uploadPath = scriptDir & "\src\upload_to_r2.py"

' 1. Run main.py (0 = hide window, True = wait for completion)
mainCmd = """" & pyPath & """ -u """ & mainPath & """"
mainExitCode = ws.run(mainCmd, 0, True)

If mainExitCode <> 0 Then
    WScript.Quit mainExitCode
End If

' 2. Upload only after main.py succeeds, and propagate upload failure.
uploadCmd = """" & pyPath & """ -u """ & uploadPath & """"
uploadExitCode = ws.run(uploadCmd, 0, True)
WScript.Quit uploadExitCode
