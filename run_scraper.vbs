Set ws = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get directory of this VBScript file
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Set environment variables directly in the script process
Set env = ws.Environment("Process")
env("PYTHONIOENCODING") = "utf-8"

' Build paths to python inside virtualenv and python scripts
pyPath = scriptDir & "\.venv\Scripts\python.exe"
mainPath = scriptDir & "\main.py"
uploadPath = scriptDir & "\src\upload_to_r2.py"

' 1. Run main.py (0 = hide window, True = wait for completion)
mainCmd = """" & pyPath & """ -u """ & mainPath & """"
exitCode = ws.run(mainCmd, 0, True)

If exitCode = 0 Then
    ' 2. Run upload_to_r2.py only if main.py succeeded
    uploadCmd = """" & pyPath & """ -u """ & uploadPath & """"
    ws.run uploadCmd, 0, True
End If
