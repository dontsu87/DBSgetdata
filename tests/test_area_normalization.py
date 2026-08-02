# -*- coding: utf-8 -*-
import json

import pandas as pd
import pytest

import src.dashboard_generator as generator
from src.dashboard_generator import (
    get_area_by_coords,
    is_coords_in_area,
    normalize_area_name,
)


@pytest.mark.parametrize(
    ('legacy_name', 'current_name'),
    [
        ('FKI_ふくチャリ', '福井'),
        ('KMT_こまつシェアサイクル', '小松'),
        ('KNZ_金沢市公共シェアサイクルまちのり事務局', '金沢'),
        ('SNN_上田市千曲市広域シェアサイクル', '上田千曲広域'),
        ('TRG_つるがシェアサイクル事務局', '敦賀'),
        ('TRG_Tokyo Ring', '敦賀'),
        ('KNZ', '金沢'),
    ],
)
def test_normalize_area_name_migrates_legacy_labels(legacy_name, current_name):
    assert normalize_area_name(legacy_name) == current_name


def test_current_area_names_remain_unchanged():
    for area_name in ('福井', '小松', '金沢', '上田千曲広域', '敦賀'):
        assert normalize_area_name(area_name) == area_name


@pytest.mark.parametrize(
    ('lat', 'lon', 'expected'),
    [
        (36.57, 136.65, '金沢'),
        (36.06, 136.22, '福井'),
        (36.40, 136.45, '小松'),
        (36.40, 138.20, '上田千曲広域'),
        (35.65, 136.06, '敦賀'),
    ],
)
def test_geofence_returns_current_area_names(lat, lon, expected):
    assert get_area_by_coords(lat, lon) == expected
    assert is_coords_in_area(expected, lat, lon)


def test_sync_port_area_master_migrates_saved_legacy_values(tmp_path, monkeypatch):
    master_path = tmp_path / 'port_area_master.json'
    master_path.write_text(
        json.dumps(
            {
                'ports': {'旧金沢ポート': 'KNZ_金沢市公共シェアサイクルまちのり事務局'},
                'stations': {'00000001': 'TRG_つるがシェアサイクル事務局'},
            },
            ensure_ascii=False,
        ),
        encoding='utf-8',
    )
    monkeypatch.setattr(generator, 'ROOT_DIR', tmp_path)
    monkeypatch.setattr(generator.Config, 'OUTPUT_DIR', str(tmp_path))

    frame = pd.DataFrame(
        [
            {
                'ポート名': '現行金沢ポート',
                'エリア名': '金沢',
                'station_id': 2,
                'lat': 36.57,
                'lon': 136.65,
            }
        ]
    )

    master, _ = generator.sync_port_area_master(frame)

    assert master['ports']['旧金沢ポート'] == '金沢'
    assert master['stations']['00000001'] == '敦賀'
    assert master['ports']['現行金沢ポート'] == '金沢'
    assert master['stations']['00000002'] == '金沢'
