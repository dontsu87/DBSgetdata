Set ws = CreateObject("Wscript.Shell")
' Run the batch file in the background (0 = hide window, True = wait for completion)
ws.run "cmd /c D:\antigravity\DBSgetdata\run_scraper.bat", 0, True
