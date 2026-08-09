"""Backend tests for radacini OBD-II API."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://obd-scanner-12.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def sample_vehicle():
    return {
        "vin": "TEST_VIN1234567890",
        "make": "TestMake",
        "model": "TestModel",
        "year": 2022,
        "mileage": 12345,
    }


@pytest.fixture(scope="module")
def sample_faults():
    return [
        {"code": "P0301", "group": "engine", "title": "Misfire Cyl 1",
         "description": "Cylinder 1 misfire detected", "severity": "high"},
        {"code": "B1234", "group": "body", "title": "Body module",
         "description": "Body module fault", "severity": "low"},
    ]


created_ids = []


# ---------- Health ----------
class TestHealth:
    def test_root(self, api):
        r = api.get(f"{API}/")
        assert r.status_code == 200
        assert r.json().get("message") == "radacini OBD API"


# ---------- Scans CRUD ----------
class TestScans:
    def test_create_scan_with_faults(self, api, sample_vehicle, sample_faults):
        payload = {"vehicle": sample_vehicle, "faults": sample_faults, "device_name": "TEST_Adapter"}
        r = api.post(f"{API}/scans", json=payload)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["status"] == "faults"
        assert data["fault_count"] == 2
        assert data["device_name"] == "TEST_Adapter"
        assert data["vehicle"]["vin"] == sample_vehicle["vin"]
        assert "id" in data and "created_at" in data
        assert "_id" not in data
        created_ids.append(data["id"])

    def test_create_scan_empty_faults(self, api, sample_vehicle):
        payload = {"vehicle": sample_vehicle, "faults": [], "device_name": "TEST_Adapter"}
        r = api.post(f"{API}/scans", json=payload)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        assert data["fault_count"] == 0
        assert data["faults"] == []
        created_ids.append(data["id"])

    def test_list_scans_sorted_desc_no_id_leak(self, api):
        r = api.get(f"{API}/scans")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 2
        # no _id leakage
        for item in data:
            assert "_id" not in item
            assert "id" in item and "created_at" in item
        # sorted desc
        times = [item["created_at"] for item in data]
        assert times == sorted(times, reverse=True)

    def test_get_scan_by_id(self, api):
        assert created_ids, "no created ids"
        sid = created_ids[0]
        r = api.get(f"{API}/scans/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert data["id"] == sid
        assert "_id" not in data

    def test_get_scan_not_found(self, api):
        r = api.get(f"{API}/scans/does-not-exist-xyz")
        assert r.status_code == 404

    def test_delete_scan(self, api):
        assert created_ids
        sid = created_ids.pop(0)
        r = api.delete(f"{API}/scans/{sid}")
        assert r.status_code == 200
        assert r.json().get("deleted") is True
        # verify gone
        r2 = api.get(f"{API}/scans/{sid}")
        assert r2.status_code == 404

    def test_delete_scan_not_found(self, api):
        r = api.delete(f"{API}/scans/does-not-exist-xyz")
        assert r.status_code == 404


def teardown_module(module):
    # cleanup any leftover TEST_ scans
    try:
        r = requests.get(f"{API}/scans", timeout=10)
        if r.status_code == 200:
            for s in r.json():
                if s.get("vehicle", {}).get("vin", "").startswith("TEST_"):
                    requests.delete(f"{API}/scans/{s['id']}", timeout=10)
    except Exception:
        pass
