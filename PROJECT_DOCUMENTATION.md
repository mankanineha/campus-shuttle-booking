# 🚌 Campus Hopper: High-Concurrency Smart Shuttle Seat Allocation & Cloud-Native Concurrency System
## End-to-End Technical Documentation & Architecture Report
**Course:** Advanced Cloud Computing & DevOps (ACC)  
**Academic Year:** 4th Year B.Tech / B.E. Computer Engineering  

---

## 1. Executive Synopsis

### 1.1 Problem Statement
In university campus environments, transit demand is heavily synchronized during peak hours (morning rush between 08:00 AM – 09:00 AM and evening transit between 05:00 PM – 06:00 PM). Thousands of students simultaneously open their devices to reserve limited shuttle seats (typically 24 seats per vehicle) within seconds.

Traditional monolithic applications processing direct relational database transactions fail under this **"Thundering Herd"** problem due to:
1. **Connection Pool Exhaustion:** Hundreds of concurrent HTTP threads contending for a finite set of database connections.
2. **Race Conditions & Double-Bookings:** Read-modify-write latencies allow two or more students to simultaneously read a seat as "available" and attempt concurrent `INSERT` operations, leading to integrity violations.
3. **Database Deadlocks & Lock Contention:** Heavy row-level locks in PostgreSQL degrade throughput, resulting in request timeouts and server crashes (`502 Bad Gateway` / `504 Gateway Timeout`).

### 1.2 Proposed Solution & Project Scope
**Campus Hopper** is a production-grade, containerized distributed microservice designed to eliminate race conditions while handling high-throughput rush-hour traffic. Inspired by commercial airline and high-speed rail reservation architectures (like Amadeus, IRCTC), the system introduces:
- **Two-Tier Locking Hierarchy:** An ultra-fast in-memory atomic gate (**Redis `SETNX`**) handles provisional holds and rejects conflicting requests in **< 3ms**, completely shielding the persistent database (**PostgreSQL**) from unneeded transaction load.
- **ACID Transaction Finalization:** Final ticket confirmation uses strict row-level database locking (`SELECT ... FOR UPDATE`) with unique relational constraints.
- **Dockerized Container Architecture:** Multi-stage container builds, Alpine-based Nginx reverse proxies with dynamic runtime environment injection, container network isolation, and Docker Compose orchestration.
- **Cloud Elasticity & Autoscaling:** Real-time waitlist monitoring in Redis; when demand exceeds capacity, the system dynamically provisions a **Relief Backup Shuttle** with 24 fresh seats.
- **30-Minute Transit Cycle Turnaround:** A realistic 15-minute campus ride with automated round-trip cycle turnaround timer and auto-redirect.
- **Digital Boarding Pass Verification:** Dynamic QR code generation that directs mobile scanners to a dedicated verified digital pass (`verify.html`).

---

## 2. End-to-End Technology Stack

| Layer | Technology | Version | Purpose in this Project |
|---|---|---|---|
| **Client UI** | Modern HTML5, CSS3, ES6+ JavaScript | Native | Interactive bus schematic layout, Web Audio tactile acoustic feedback, live WebSocket/polling telemetry. |
| **Reverse Proxy / Web Server** | Nginx on Alpine Linux | `alpine` | Serves static assets, terminates HTTP, proxies `/api/` traffic dynamically via `envsubst` to backend. |
| **Application Layer** | FastAPI (Python Asynchronous ASGI) | `0.111.0` | Stateless microservice pods handling asynchronous route, shuttle, locking, and booking APIs. |
| **ASGI Server** | Uvicorn | `0.30.1` | High-performance asynchronous worker running FastAPI with low event-loop latency. |
| **In-Memory Cache & Lock Manager** | Redis (Valkey compatible) | `7-alpine` | Distributed atomic provisional holds (`SETNX`), TTL key expiration, Lua script execution, real-time waitlists. |
| **Relational Database (ACID)** | PostgreSQL | `15/16-alpine` | Durable persistence of routes, shuttles, seats, and confirmed tickets with foreign key constraints. |
| **Database ORM** | SQLAlchemy 2.0 | `2.0.31` | Python SQL Toolkit implementing connection pooling, row-level `with_for_update()`, and declarative mapping. |
| **Data Validation** | Pydantic v2 | `2.8.2` | Strict runtime request/response payload schema parsing and type enforcement. |
| **Observability & Metrics** | Prometheus FastApi Instrumentator | `7.0.0` | Exposes `/metrics` endpoint for real-time scraped telemetry (request count, latency histograms, status codes). |
| **Container Engine & Orchestration** | Docker, Docker Compose, Kubernetes | Engine 24+ | Multi-stage Docker builds, isolated bridge networking, healthchecks, PVC, and HPA auto-scaling. |
| **Cloud Hosting & Deployment** | Render.com Web Services & GitOps | Cloud | Cloud-deployed live services with automated GitOps deployment triggers on push to `main`. |

---

## 3. Deep Dive: Docker & Container Architecture

The project is built container-first. Docker ensures identical behavior across local Mac machines, CI/CD automated test runners, and production cloud infrastructure.

```
+-----------------------------------------------------------------------------------+
|                            DOCKER COMPOSE / CLOUD POD                              |
|                                                                                   |
|   +--------------------+          +--------------------+                          |
|   |  frontend (Nginx)  |  proxy   |  backend (FastAPI) |                          |
|   |  Port 80/8080      |--------->|  Port 8000         |                          |
|   |  Alpine + Envsubst |          |  Python 3.11-slim  |                          |
|   +--------------------+          +--------------------+                          |
|                                             |                                     |
|                                +------------+------------+                        |
|                                |                         |                        |
|                                ▼                         ▼                        |
|                      +-------------------+     +--------------------+             |
|                      |   redis (Redis 7) |     |  postgres (PG 15)  |             |
|                      |   Port 6379       |     |  Port 5432         |             |
|                      |   In-Memory Cache |     |  Named Volume:     |             |
|                      +-------------------+     |  postgres_data     |             |
|                                                +--------------------+             |
+-----------------------------------------------------------------------------------+
```

### 3.1 Multi-Stage Dockerfile for the Backend Microservice
Located in `backend/Dockerfile`:

```dockerfile
# Stage 1: Build dependencies with compiler tools
FROM python:3.11-slim as builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# Stage 2: Minimal runtime image without heavy build tools
FROM python:3.11-slim as runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy only the compiled binaries and packages from builder stage
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH
ENV PYTHONUNBUFFERED=1

COPY app/ ./app/
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

#### Why Multi-Stage Docker Builds Matter (Key Teacher Explanation Points):
1. **Minimizing Attack Surface:** Build tools like `gcc` and development headers (`libpq-dev`) are omitted from the final production container. If an attacker breaches the container, they cannot compile malicious binaries.
2. **Container Size Reduction:** The build tools can inflate image sizes past 800 MB. The multi-stage separation keeps the production runtime container lean (~160 MB), resulting in faster pulling, lower memory footprint, and faster pod autoscaling spin-up times.
3. **Layer Caching Optimization:** `requirements.txt` is copied and installed prior to copying `app/`. Docker caches the package installation layer; changing Python code in `app/` does not trigger re-installation of dependencies.

---

### 3.2 Dynamic Nginx Container with Runtime Environment Substitution
Located in `frontend/Dockerfile` and `frontend/nginx.conf`:

```dockerfile
FROM nginx:alpine
RUN apk add --no-cache gettext

COPY index.html /usr/share/nginx/html/
COPY verify.html /usr/share/nginx/html/
COPY style.css /usr/share/nginx/html/
COPY app.js /usr/share/nginx/html/

# Copy nginx template (uses ${BACKEND_URL} placeholder)
COPY nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

#### How Nginx Dynamic Reverse Proxying Works:
In cloud hosting (such as Render or Kubernetes), the backend URL is not static localhost—it is assigned an external domain (e.g. `https://campus-hopper-backend.onrender.com`).
1. Instead of baking a hardcoded URL into the Docker image, Nginx uses a template:
   ```nginx
   location /api/ {
       proxy_pass ${BACKEND_URL};
       proxy_set_header Host $proxy_host;
       proxy_ssl_server_name on;
       resolver 8.8.8.8 8.8.4.4 valid=30s;
   }
   ```
2. When the Alpine container boots up, Nginx's entrypoint script executes `envsubst` against `/etc/nginx/templates/default.conf.template`, reads the `BACKEND_URL` environment variable, injects the real URL into `/etc/nginx/conf.d/default.conf`, and starts Nginx.
3. **No rebuilds are required:** Changing environments (Local -> Staging -> Production) requires only changing the environment variable.

---

### 3.3 Multi-Service Orchestration with Docker Compose
Located in `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    container_name: shuttle-postgres
    environment:
      POSTGRES_USER: shuttle_user
      POSTGRES_PASSWORD: shuttle_pass
      POSTGRES_DB: shuttle_db
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    container_name: shuttle-redis
    ports:
      - "6379:6379"

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: shuttle-backend
    environment:
      DATABASE_URL: postgresql://shuttle_user:shuttle_pass@postgres:5432/shuttle_db
      REDIS_HOST: redis
      REDIS_PORT: 6379
      POD_NAME: docker-compose-pod-1
    ports:
      - "8000:8000"
    depends_on:
      - postgres
      - redis

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    container_name: shuttle-frontend
    ports:
      - "8080:80"
    environment:
      BACKEND_URL: http://backend:8000
    depends_on:
      - backend

volumes:
  postgres_data:
```

#### Core Docker Networking & Volume Features Highlighted:
- **Internal DNS Bridge Network:** In `docker-compose`, Docker creates an isolated virtual network where each container's name becomes an internal DNS entry. `backend` connects to PostgreSQL simply via `postgres:5432` and Redis via `redis:6379`.
- **Persistent Volumes (`volumes: [postgres_data]`):** Containers are ephemeral; stopping or deleting a container destroys its internal storage. The named volume `postgres_data` persists the database files on the host disk even when containers are restarted or rebuilt.
- **Service Dependency Sequencing (`depends_on`):** Ensures that the data backbones (`postgres` and `redis`) boot up before the application `backend` launches.

---

## 4. Concurrency Engineering: Two-Tier Distributed Locking

The core innovation of this project is its concurrency architecture that guarantees **Zero Double-Bookings** while maintaining low latency.

```mermaid
sequenceDiagram
    autonumber
    actor S1 as Student A (1ms faster)
    actor S2 as Student B (contender)
    participant API as FastAPI Backend Pod
    participant R as Redis (In-Memory Fast Gate)
    participant DB as PostgreSQL (ACID Storage)

    Note over S1,S2: Both tap Seat 3A simultaneously
    S1->>API: POST /api/seats/lock {seat_id: 3, student_id: "21BCE1042"}
    S2->>API: POST /api/seats/lock {seat_id: 3, student_id: "22BIT0045"}

    API->>R: SET lock:seat:3 "21BCE1042" EX 30 NX
    R-->>API: 1 (Acquired successfully)
    API-->>S1: HTTP 200 OK (30-second provisional hold active)

    API->>R: SET lock:seat:3 "22BIT0045" EX 30 NX
    R-->>API: 0 (Key already exists)
    API-->>S2: HTTP 409 Conflict (< 3ms fast reject, DB untouched!)

    Note over S1: Student A confirms within 30s
    S1->>API: POST /api/book {seat_id: 3, student_id: "21BCE1042"}
    API->>DB: SELECT * FROM seats WHERE id = 3 FOR UPDATE
    DB-->>API: Seat 3 locked row
    API->>DB: INSERT INTO bookings ...; UPDATE seats SET is_reserved = true;
    DB-->>API: COMMIT SUCCESS
    API->>R: Lua Script: release lock if owner == "21BCE1042"
    R-->>API: Released
    API-->>S1: HTTP 201 Created (Digital Ticket Generated)
```

### 4.1 Tier 1: Redis `SETNX` Fast Gate (Located in `redis_client.py`)
```python
async def acquire_seat_lock(seat_id: int, student_id: str, ttl_seconds: int = 30) -> Tuple[bool, str]:
    r = await get_redis_client()
    key = f"lock:seat:{seat_id}"
    
    # Atomic command: SET key value EX seconds NX
    # NX: Only set if the key does NOT already exist.
    # EX: Automatically expire after ttl_seconds (preventing deadlocks).
    acquired = await r.set(key, student_id, ex=ttl_seconds, nx=True)
    
    if acquired:
        return True, f"Provisional lock granted for {ttl_seconds}s"
    
    # If key exists, check if caller already holds it (re-entrant lock extension)
    current_holder = await r.get(key)
    if current_holder == student_id:
        await r.expire(key, ttl_seconds)
        return True, f"Provisional lock extended for {ttl_seconds}s"
        
    return False, f"Seat {seat_id} is currently being held by another student"
```

#### Why Lua Script for Lock Release?
```python
LUA_RELEASE_LOCK = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""
```
If client A holds a lock that expires right as Client B acquires it, a plain `DEL lock:seat:3` from Client A would accidentally delete Client B's lock! The Lua script runs **atomically** on the Redis server: it inspects the owner and only deletes the key if the caller matches the recorded student ID.

---

### 4.2 Tier 2: Relational ACID Finalization (Located in `main.py`)
```python
# PostgreSQL Row-Level Lock inside a Transaction
seat = db.query(Seat).with_for_update().filter(Seat.id == seat_id).first()

if seat.is_reserved:
    await release_seat_lock(seat_id, student_id)
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"Seat {seat.seat_number} is already reserved by another student"
    )

booking = Booking(
    seat_id=seat.id,
    student_id=student_id,
    student_name=student_name,
    booking_reference=f"TKT-{uuid.uuid4().hex[:8].upper()}",
    status="CONFIRMED"
)
seat.is_reserved = True
db.add(booking)
db.commit() # Atomic Commit
```
- `.with_for_update()` issues `SELECT ... FOR UPDATE` in SQL, locking the row until transaction commit.
- In `models.py`, `UniqueConstraint("seat_id", name="uq_seat_active_booking")` enforces that even in the theoretical event of thread corruption, PostgreSQL's B-Tree index guarantees that two bookings can never reference the same `seat_id`.

---

## 5. Cloud Elasticity, Surge Autoscaling & Turnaround Architecture

To reflect advanced cloud design concepts, Campus Hopper implements automated elasticity and realistic transit scheduling.

### 5.1 Real-Time Waitlist & Dynamic Relief Shuttle Provisioning
When a 24-seat shuttle reaches 100% capacity:
1. Students who missed out can tap **`📢 Join Waitlist for Relief Bus`**.
2. Redis tracks the waitlist using a Hash (`HSET waitlist:shuttle:{id} {student_id} {student_name}`).
3. **Surge Threshold Detection (`THRESHOLD = 3`):**
   When 3 students join the waitlist, the backend automatically triggers **Horizontal Relief Autoscaling**:
   ```python
   # main.py: auto-dispatches extra bus on surge threshold
   relief_vehicle_num = f"{shuttle.vehicle_number}-RELIEF"
   new_shuttle = Shuttle(
       route_id=shuttle.route_id,
       vehicle_number=relief_vehicle_num,
       capacity=24,
       status="BOARDING"
   )
   db.add(new_shuttle)
   db.commit()
   # Seeds 24 fresh available seats (1A - 6D)
   for row_idx in range(1, 7):
       for letter in ["A", "B", "C", "D"]:
           db.add(Seat(shuttle_id=new_shuttle.id, seat_number=f"{row_idx}{letter}"))
   db.commit()
   ```
4. **Instant Auto-Redirect:** The frontend detects the newly created shuttle, plays an alert, renders the glowing **`FLEET: [ Bus 1 ] [ 🚀 Relief Bus 2 ]`** tabs, and auto-switches users directly to the new bus with 24 fresh seats.

### 5.2 30-Minute Transit Cycle Turnaround (`15m ride × 2`)
Campus shuttles follow cyclical schedules:
- When a shuttle fills up and departs on its 15-minute one-way trip to the Academic Block, a round-trip turnaround timer initiates: `15 min departure + 15 min return = 30 minutes (1800s)`.
- A live countdown displays in both the route hero stats and the departed banner (`TRANSIT CYCLE: 29:54`).
- When the countdown reaches `00:00`, the system automatically clears bookings and refreshes the shuttle for the next trip cycle.

### 5.3 Mobile Boarding Pass & QR Code Verification Subsystem
Located in `frontend/verify.html`:
- Rather than encoding raw text (which causes mobile phone cameras to report *"no app can read this info"*), the QR code encodes a verified web URL:
  `https://campus-hopper-frontend.onrender.com/verify.html?ref=TKT-XXXX&seat=2B&name=...`
- Scanning with an iPhone or Android camera immediately displays the link prompt, opening an official digital verification pass with a green verified seal, passenger name, seat number, and departure details.
- A direct button `📱 Open Verified Pass ↗` is also embedded on the ticket for one-click desktop browser inspection.

---

## 6. Professor Viva & Oral Evaluation Q&A Guide

Here are the most critical questions professors ask during 4th-year cloud computing evaluations, along with the precise answers based on your architecture:

### Q1: "Why do you need Redis if PostgreSQL already supports row-level locking with `FOR UPDATE`?"
> **Answer:** *"If 500 students compete for 1 seat at 08:30 AM, sending all 500 requests directly to PostgreSQL forces the database to open 500 concurrent transactions, serialize 500 row locks, and reject 499 of them. This causes connection pool exhaustion, high disk I/O, and server timeouts. By placing Redis in front as an In-Memory Fast Gate using `SETNX`, 1 request succeeds while the other 499 are rejected in memory in under 3 milliseconds. PostgreSQL only receives 1 clean transactional write, completely shielding the database from lock contention."*

### Q2: "What happens if a student locks a seat for 30 seconds but their phone dies or they close the tab?"
> **Answer:** *"The Redis lock uses an automatic TTL (Time-To-Live) expiration: `SET lock:seat:id student_id EX 30 NX`. If the student disconnects or fails to confirm the booking within 30 seconds, Redis automatically evicts the key without needing any manual cleanup query. The seat becomes instantly available for other students on the next polling cycle."*

### Q3: "Explain why you used a Multi-Stage build in your Backend Dockerfile."
> **Answer:** *"Our backend requires compiling C-extensions for PostgreSQL (`psycopg2`) using `gcc` and `libpq-dev`. If we use a single-stage image, all those heavy compilation tools stay inside the final production container, creating an image over 800 MB with an unnecessarily large security attack surface. By using a multi-stage build, Stage 1 builds the dependencies into `/root/.local`, and Stage 2 copies only the compiled Python binaries into a lean `python:3.11-slim` runtime image (~160 MB), resulting in faster cloud deployment and lower memory usage."*

### Q4: "How does the Nginx frontend communicate with the FastAPI backend without hardcoded IP addresses?"
> **Answer:** *"In our Docker Compose environment, Docker provides an internal DNS bridge network where containers resolve each other by service name (`http://backend:8000`). For our live Render cloud deployment, we configured Nginx on Alpine with `gettext` and `envsubst`. When the frontend container boots, Nginx reads the `BACKEND_URL` environment variable, substitutes the placeholder in `default.conf.template`, and proxies `/api/` calls seamlessly over HTTPS with `proxy_ssl_server_name on` and external DNS resolution."*

### Q5: "How does your project demonstrate Cloud Elasticity and Autoscaling?"
> **Answer:** *"We demonstrate elasticity on two layers:
> 1. **Infrastructure layer:** Our Kubernetes manifests configure Horizontal Pod Autoscaling (HPA) to scale FastAPI backend pods from 2 up to 10 replicas when average CPU exceeds 70%.
> 2. **Application domain layer:** When demand exceeds physical bus capacity, our Redis waitlist tracks overflow passengers. When 3 students join the waitlist, the system automatically provisions and seeds an Extra Relief Shuttle (`CAMPUS-EXPRESS-01-RELIEF`) with 24 fresh seats and auto-redirects passengers to the relief bus, demonstrating dynamic resource provisioning under surge load."*

---

## 7. Verification & Live Deployment Checklist

To verify the live application:
- **Live Frontend Web App:** `https://campus-hopper-frontend.onrender.com`
- **Live Backend API Docs:** `https://campus-hopper-backend.onrender.com/docs`
- **Prometheus Telemetry Metrics:** `https://campus-hopper-backend.onrender.com/metrics`
- **Health Check Endpoint:** `https://campus-hopper-backend.onrender.com/api/health`
- **Digital Pass Scanner URL:** `https://campus-hopper-frontend.onrender.com/verify.html`
