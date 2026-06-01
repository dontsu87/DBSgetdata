# -*- coding: utf-8 -*-
import sys
import os
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.append(str(ROOT_DIR))

from src.config import Config
from src.browser import build_driver, BrowserUtils
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

def diagnose():
    Config.validate()
    print("🔄 Browser launching...")
    driver = build_driver()
    utils = BrowserUtils(driver)
    
    try:
        print("🔗 Navigating to link...")
        driver.get(Config.ONEDRIVE_SHARED_LINK)
        
        # Password
        try:
            pwd_input = utils.W(5).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='password'], #sharepoint-password-input"))
            )
            pwd_input.clear()
            pwd_input.send_keys(Config.ONEDRIVE_PASSWORD)
            btn = driver.find_element(By.CSS_SELECTOR, "input[type='submit'], button[type='submit']")
            utils.click_js(btn)
            time.sleep(4)
        except Exception:
            pass

        # Click uploadCommand
        print("⏳ Waiting for uploadCommand...")
        upload_btn = utils.W(15).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "button[data-automationid='uploadCommand']"))
        )
        utils.click_js(upload_btn)
        time.sleep(1)
        
        # Click uploadFileCommand
        print("⏳ Waiting for uploadFileCommand...")
        file_btn = utils.W(5).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "button[data-automationid='uploadFileCommand']"))
        )
        print("👉 Clicking uploadFileCommand...")
        # Note: We click it via JS to prevent browser lockup or blocking dialog issues
        utils.click_js(file_btn)
        time.sleep(2)
        
        # Check inputs in DOM
        inputs = driver.find_elements(By.TAG_NAME, "input")
        print("\n🔍 Inputs found in DOM:")
        for idx, inp in enumerate(inputs):
            try:
                print(f"  - Input {idx+1}: type={inp.get_attribute('type')}, class={inp.get_attribute('class')}, id={inp.get_attribute('id')}")
            except Exception:
                pass
                
    except Exception as e:
        print(f"❌ Error: {e}")
    finally:
        driver.quit()

if __name__ == "__main__":
    diagnose()
