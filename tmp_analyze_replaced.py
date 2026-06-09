# -*- coding: utf-8 -*-
import sys, json, glob, os, csv
sys.stdout.reconfigure(encoding='utf-8')

# --- 1. dashboard_data.json から交換済みフラグ車両を取得 ---
with open('dashboard_data.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

all_replaced = []
for port in data['ports']:
    for bike in port['bikes']:
        if bike.get('replaced_at'):
            all_replaced.append({
                'bike_id': bike['bike_id'],
                'port': port['port_name'],
                'alert_level': bike.get('alert_level'),
                'alert_level_name': bike.get('alert_level_name'),
                'battery_voltage': bike.get('battery_voltage'),
                'replaced_at': bike.get('replaced_at'),
                'replace_original_volt': bike.get('replace_original_volt'),
            })

print('=== 交換済みフラグのある全車両 ===')
for b in all_replaced:
    flag = ' !! 要確認' if b['alert_level'] in [4, 5] else ''
    print(f"  {b['bike_id']} | {b['port']} | 現在:{b['battery_voltage']}V ({b['alert_level_name']}) | 交換前:{b['replace_original_volt']}V | {b['replaced_at']}{flag}")

suspicious = [b for b in all_replaced if b['alert_level'] in [4, 5]]
print()
print(f'=== 現在「低」または「最低」の交換済みフラグ車両: {len(suspicious)}件 ===')
for b in suspicious:
    print(f"  {b['bike_id']} | {b['port']} | 現在:{b['battery_voltage']}V ({b['alert_level_name']}) | 交換前:{b['replace_original_volt']}V | 交換検知:{b['replaced_at']}")

# --- 2. CSVログから対象車両の電圧推移を取得 ---
if suspicious:
    suspect_ids = [b['bike_id'] for b in suspicious]
    csv_files = sorted(glob.glob('output/車両情報_20260609_*.csv'))
    
    print()
    print('=== バッテリー電圧ログ推移 ===')
    print(f'  参照CSVファイル数: {len(csv_files)}件')
    print()
    
    # 各車両の電圧ログを収集
    history = {bid: [] for bid in suspect_ids}
    
    for csv_path in csv_files:
        fname = os.path.basename(csv_path)
        # ファイル名からタイムスタンプ取得 (例: 車両情報_20260609_150125.csv → 15:01:25)
        try:
            ts_part = fname.replace('車両情報_20260609_', '').replace('.csv', '')
            hh = ts_part[0:2]
            mm = ts_part[2:4]
            ss = ts_part[4:6]
            time_label = f'{hh}:{mm}:{ss}'
        except Exception:
            time_label = fname
        
        try:
            with open(csv_path, 'r', encoding='utf-8-sig') as cf:
                reader = csv.DictReader(cf)
                for row in reader:
                    bid = row.get('識別番号', '').strip()
                    if bid in history:
                        volt = row.get('電圧', '')
                        status = row.get('車両状態', '')
                        history[bid].append((time_label, volt, status))
        except Exception as e:
            pass
    
    for bid in suspect_ids:
        b_info = next(b for b in suspicious if b['bike_id'] == bid)
        print(f'--- {bid} ({b_info["port"]}) ---')
        print(f'    交換検知日時: {b_info["replaced_at"]} | 交換前電圧: {b_info["replace_original_volt"]}V | 現在: {b_info["battery_voltage"]}V ({b_info["alert_level_name"]})')
        if history[bid]:
            for (t, v, st) in history[bid]:
                print(f'    {t}  {v}V  [{st}]')
        else:
            print('    (CSVログなし)')
        print()
