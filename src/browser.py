# -*- coding: utf-8 -*-
import os
import subprocess
import warnings
import logging
import platform
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.by import By
from selenium.common.exceptions import TimeoutException
from src.config import Config

# ログ設定
logging.basicConfig(level=logging.CRITICAL)
os.environ.setdefault("WDM_LOG_LEVEL", "0")
os.environ.setdefault("WDM_PRINT_FIRST_LINE", "False")
os.environ.setdefault("CHROME_LOG_FILE", "NUL")
warnings.filterwarnings("ignore")

def get_windows_screen_size():
    try:
        if platform.system() != "Windows":
            return None
        import ctypes
        user32 = ctypes.windll.user32
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                user32.SetProcessDPIAware()
            except Exception:
                pass
        w = user32.GetSystemMetrics(0)
        h = user32.GetSystemMetrics(1)
        return (int(w), int(h)) if w > 0 and h > 0 else None
    except Exception:
        return None

def build_driver():
    """Chrome WebDriverを構築します。"""
    options = webdriver.ChromeOptions()

    # 自動ダウンロードフォルダの設定 (プロジェクトのルートフォルダを指定)
    from src.config import ROOT_DIR
    prefs = {
        "download.default_directory": str(ROOT_DIR),
        "download.prompt_for_download": False,
        "download.directory_upgrade": True,
        "safebrowsing.enabled": True
    }
    options.add_experimental_option("prefs", prefs)

    # ログ抑制設定
    options.add_experimental_option("excludeSwitches", ["enable-logging"])
    options.add_argument("--log-level=3")
    options.add_argument("--disable-logging")
    options.add_argument("--remote-debugging-pipe")

    # 音声系/通知系を極力オフ
    options.add_argument("--disable-speech-api")
    options.add_argument("--mute-audio")
    options.add_argument(
        "--disable-features="
        "LiveCaption,"
        "OnDeviceSpeechRecognition,"
        "SodaOnDeviceSpeechRecognition,"
        "HeadlessLiveCaptions"
    )

    if Config.HEADLESS:
        size = get_windows_screen_size()
        if size:
            options.add_argument(f"--window-size={size[0]},{size[1]}")
        else:
            options.add_argument("--window-size=1920,1080")
        options.add_argument("--headless=new")
    else:
        options.add_argument("--start-maximized")

    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    # GitHub Actions (Docker/Linux) 環境での Chrome クラッシュ防止（正式推奨フラグ）
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-setuid-sandbox")
    options.add_argument("--disable-software-rasterizer")
    options.add_argument("--disable-background-networking")
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-sync")
    options.add_argument("--disable-translate")
    options.add_argument("--disable-notifications")
    # eager 戦略は高速ですが、DOM破棄時にバックグラウンド通信がセグメンテーションフォルトを誘発するため標準(normal)に戻します

    service = Service(
        ChromeDriverManager().install(),
        log_output=subprocess.DEVNULL
    )

    driver = webdriver.Chrome(service=service, options=options)
    driver.set_page_load_timeout(40)  # VPN環境の遅延に対応するためタイムアウト値を40秒に緩和

    if not Config.HEADLESS:
        try:
            driver.maximize_window()
        except Exception:
            pass

    return driver

class BrowserUtils:
    def __init__(self, driver):
        self.driver = driver
        self.wait_short = 8
        self.wait_long = 20
        self.poll = 0.5

    def W(self, timeout: int):
        return WebDriverWait(self.driver, timeout, poll_frequency=self.poll)

    def click_js(self, el):
        """JavaScriptで要素を安全にクリックします。"""
        self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
        self.driver.execute_script("arguments[0].click();", el)

    def safe_is_displayed(self, el):
        try:
            return el.is_displayed()
        except Exception:
            return False

    def find_visible(self, locator, timeout=12):
        """表示中の要素を安全に取得します。"""
        self.W(timeout).until(EC.presence_of_all_elements_located(locator))
        for e in self.driver.find_elements(*locator):
            if self.safe_is_displayed(e):
                return e
        raise TimeoutException(f"表示要素が見つかりません: {locator}")
