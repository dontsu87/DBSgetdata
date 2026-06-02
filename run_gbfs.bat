@echo off
rem Change directory to batch file folder
cd /d "%~dp0"

rem Set Python IO encoding to UTF-8 to prevent UnicodeEncodeError with emojis
set PYTHONIOENCODING=utf-8

rem Activate virtual environment
call .venv\Scripts\activate

rem Run Python GBFS retriever script
python -u main.py --gbfs
