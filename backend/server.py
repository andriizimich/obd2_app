from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime, timezone


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# ---------- Models ----------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Vehicle(BaseModel):
    vin: str
    make: str
    model: str
    year: int
    mileage: int


class Fault(BaseModel):
    code: str
    group: str            # engine | transmission | lights | brakes | emissions | electrical | body
    title: str
    description: str
    severity: str = "medium"   # low | medium | high


class ScanCreate(BaseModel):
    vehicle: Vehicle
    faults: List[Fault] = Field(default_factory=list)
    device_name: Optional[str] = None


class Scan(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    vehicle: Vehicle
    faults: List[Fault] = Field(default_factory=list)
    fault_count: int = 0
    status: str = "ok"           # ok | faults
    device_name: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)


# ---------- Routes ----------
@api_router.get("/")
async def root():
    return {"message": "radacini OBD API"}


@api_router.post("/scans", response_model=Scan)
async def create_scan(payload: ScanCreate):
    scan = Scan(
        vehicle=payload.vehicle,
        faults=payload.faults,
        fault_count=len(payload.faults),
        status="faults" if payload.faults else "ok",
        device_name=payload.device_name,
    )
    await db.scans.insert_one(scan.dict())
    return scan


@api_router.get("/scans", response_model=List[Scan])
async def list_scans():
    docs = await db.scans.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [Scan(**doc) for doc in docs]


@api_router.get("/scans/{scan_id}", response_model=Scan)
async def get_scan(scan_id: str):
    doc = await db.scans.find_one({"id": scan_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Scan not found")
    return Scan(**doc)


@api_router.delete("/scans/{scan_id}")
async def delete_scan(scan_id: str):
    res = await db.scans.delete_one({"id": scan_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Scan not found")
    return {"deleted": True, "id": scan_id}


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
