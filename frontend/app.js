// API Endpoint (Always routed through Nginx reverse proxy)
const API_BASE = "";

let activeRoute = null;
let activeShuttle = null;
let selectedSeat = null;
let currentLockTimer = null;
let lockExpiresIn = 0;

// Audio Synthesizer for tactile feedback (Pure Web Audio API, no external files)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, type = "sine", duration = 0.15) {
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {
    // Audio might be blocked until user interacts with page
  }
}

function playSuccessChime() {
  playTone(523.25, "triangle", 0.12); // C5
  setTimeout(() => playTone(659.25, "triangle", 0.12), 100); // E5
  setTimeout(() => playTone(783.99, "triangle", 0.25), 200); // G5
}

function playRejectSound() {
  playTone(180, "sawtooth", 0.18);
  setTimeout(() => playTone(140, "sawtooth", 0.22), 120);
}

// DOM Elements
const currentPodNameEl = document.getElementById("current-pod-name");
const routeOriginEl = document.getElementById("route-origin");
const routeDestinationEl = document.getElementById("route-destination");
const routeDepartTimeEl = document.getElementById("route-depart-time");
const activeVehicleNoEl = document.getElementById("active-vehicle-no");
const activeAvailableEl = document.getElementById("active-available");
const seatGridContainer = document.getElementById("seat-grid-container");
const routeCardsContainer = document.getElementById("route-cards-container");
const btnQuickRandomStudent = document.getElementById("btn-quick-random-student");
const shuttleTabsContainer = document.getElementById("shuttle-tabs-container");
const busSignDisplay = document.getElementById("bus-sign-display");
const turnaroundDivider = document.getElementById("turnaround-divider");
const turnaroundStatCell = document.getElementById("turnaround-stat-cell");
const turnaroundTimerDisplay = document.getElementById("turnaround-timer-display");

const studentIdInput = document.getElementById("student-id");
const studentNameInput = document.getElementById("student-name");
const btnLockSeat = document.getElementById("btn-lock-seat");
const btnConfirmBook = document.getElementById("btn-confirm-book");
const btnResetDemo = document.getElementById("btn-reset-demo");
const lockStatusBox = document.getElementById("lock-status-box");
const lockedSeatDisplay = document.getElementById("locked-seat-display");
const lockTimerEl = document.getElementById("lock-timer");
const timerBar = document.getElementById("timer-bar");
const toastMessage = document.getElementById("toast-message");

const ticketCard = document.getElementById("ticket-card");
const tktStudentName = document.getElementById("tkt-student-name");
const tktStudentId = document.getElementById("tkt-student-id");
const tktSeatNo = document.getElementById("tkt-seat-no");
const tktRefCode = document.getElementById("tkt-ref-code");

let cachedRoutes = [];

// Realistic student sample profiles for instant testing
const SAMPLE_STUDENTS = [
  { id: "22BCE1089", name: "Rohan Mehta" },
  { id: "21BIT0452", name: "Priya Patel" },
  { id: "23BCS2104", name: "Ananya Iyer" },
  { id: "21BEE0315", name: "Devansh Gupta" },
  { id: "22BME1490", name: "Sneha Rao" },
  { id: "20BCE0042", name: "Kunal Verma" },
  { id: "22BEC0812", name: "Tanvi Deshmukh" },
  { id: "23BCS0941", name: "Arjun Nair" }
];

// Initialize Saved Student Info
function initPassengerInfo() {
  const savedId = localStorage.getItem("campus_hopper_student_id");
  const savedName = localStorage.getItem("campus_hopper_student_name");
  if (savedId) studentIdInput.value = savedId;
  if (savedName) studentNameInput.value = savedName;

  // Auto-fill random if completely empty
  if (!studentIdInput.value && !studentNameInput.value) {
    applyRandomStudent(false);
  }

  studentIdInput.addEventListener("input", () => {
    localStorage.setItem("campus_hopper_student_id", studentIdInput.value.trim());
  });
  studentNameInput.addEventListener("input", () => {
    localStorage.setItem("campus_hopper_student_name", studentNameInput.value.trim());
  });
}

function applyRandomStudent(notify = true) {
  const profile = SAMPLE_STUDENTS[Math.floor(Math.random() * SAMPLE_STUDENTS.length)];
  studentIdInput.value = profile.id;
  studentNameInput.value = profile.name;
  localStorage.setItem("campus_hopper_student_id", profile.id);
  localStorage.setItem("campus_hopper_student_name", profile.name);
  if (notify) {
    playTone(620, "sine", 0.1);
    showToast(`Loaded profile: ${profile.name} (${profile.id})`, "success");
  }
}

if (btnQuickRandomStudent) {
  btnQuickRandomStudent.addEventListener("click", () => applyRandomStudent(true));
}

initPassengerInfo();


async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (res.ok) {
      const data = await res.json();
      currentPodNameEl.textContent = data.pod_name || "k8s-pod";
    }
  } catch (err) {
    currentPodNameEl.textContent = "Offline";
  }
}


function renderRouteCards(routes) {
  if (!routeCardsContainer) return;
  routeCardsContainer.innerHTML = "";

  routes.forEach(route => {
    const isCurrent = activeRoute && activeRoute.id === route.id;
    const card = document.createElement("div");
    card.className = `route-card-item ${isCurrent ? "active" : ""}`;

    card.innerHTML = `
      <div class="route-card-top">
        <span class="route-card-time">⏰ ${route.departure_time || "Scheduled"}</span>
        <span class="route-card-badge">${isCurrent ? "SELECTED 📍" : "TAP TO VIEW"}</span>
      </div>
      <div class="route-card-title">${route.source}</div>
      <div class="route-card-sub">➔ ${route.destination}</div>
    `;

    card.onclick = () => selectRoute(route);
    routeCardsContainer.appendChild(card);
  });
}


async function selectRoute(route) {
  if (activeRoute && activeRoute.id === route.id) return;
  
  playTone(500, "triangle", 0.08);
  activeRoute = route;

  // Clear current selected seat & timer
  if (currentLockTimer) clearInterval(currentLockTimer);
  lockStatusBox.style.display = "none";
  selectedSeat = null;
  btnLockSeat.disabled = true;
  btnConfirmBook.disabled = true;

  // Update hero banner
  routeOriginEl.textContent = activeRoute.source;
  routeDestinationEl.textContent = activeRoute.destination;
  if (routeDepartTimeEl) {
    routeDepartTimeEl.textContent = `Depart: ${activeRoute.departure_time || "08:30 AM"}`;
  }

  // Highlight card
  renderRouteCards(cachedRoutes);

  // Fetch shuttles for this route
  try {
    const shuttlesRes = await fetch(`${API_BASE}/api/shuttles?route_id=${activeRoute.id}`);
    const shuttles = await shuttlesRes.json();
    currentRouteShuttles = shuttles || [];
    if (shuttles && shuttles.length > 0) {
      selectShuttle(shuttles[0]);
    }
  } catch (err) {
    showToast("Error switching shuttle route.", "error");
  }
}

let currentRouteShuttles = [];

function renderShuttleTabs(shuttles) {
  if (!shuttleTabsContainer) return;
  if (!shuttles || shuttles.length <= 1) {
    shuttleTabsContainer.style.display = "none";
    return;
  }

  shuttleTabsContainer.style.display = "flex";
  shuttleTabsContainer.innerHTML = `<span style="font-size: 0.74rem; font-weight: 700; color: var(--text-muted); margin-right: 4px;">FLEET:</span>`;

  shuttles.forEach((s, idx) => {
    const isRelief = s.vehicle_number.includes("-RELIEF");
    const isActive = activeShuttle && activeShuttle.id === s.id;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `shuttle-tab-btn ${isRelief ? "relief" : ""} ${isActive ? "active" : ""}`;

    btn.innerHTML = `
      <span>${isRelief ? "🚀 Relief Bus " + (idx + 1) : "🚌 Bus " + (idx + 1)}: ${s.vehicle_number}</span>
      ${isRelief ? '<span class="relief-badge">SURGE EXTRA</span>' : ''}
    `;

    btn.onclick = () => selectShuttle(s);
    shuttleTabsContainer.appendChild(btn);
  });
}

function selectShuttle(shuttle) {
  activeShuttle = shuttle;
  activeVehicleNoEl.textContent = shuttle.vehicle_number;
  if (busSignDisplay) {
    busSignDisplay.textContent = shuttle.vehicle_number.includes("-RELIEF")
      ? `🚨 RELIEF SHUTTLE • ${shuttle.vehicle_number}`
      : `SHUTTLE • ${shuttle.vehicle_number}`;
  }

  // Clear current seat selection & timer
  if (currentLockTimer) clearInterval(currentLockTimer);
  lockStatusBox.style.display = "none";
  selectedSeat = null;
  btnLockSeat.disabled = true;
  btnConfirmBook.disabled = true;

  renderShuttleTabs(currentRouteShuttles);
  loadSeats();
}


async function loadRoutesAndShuttle() {
  try {
    const res = await fetch(`${API_BASE}/api/routes`);
    const routes = await res.json();
    if (routes && routes.length > 0) {
      cachedRoutes = routes;
      renderRouteCards(routes);

      if (!activeRoute) {
        activeRoute = routes[0];
        routeOriginEl.textContent = activeRoute.source;
        routeDestinationEl.textContent = activeRoute.destination;
        if (routeDepartTimeEl) {
          routeDepartTimeEl.textContent = `Depart: ${activeRoute.departure_time || "08:30 AM"}`;
        }
      }

      const shuttlesRes = await fetch(`${API_BASE}/api/shuttles?route_id=${activeRoute.id}`);
      const shuttles = await shuttlesRes.json();
      currentRouteShuttles = shuttles || [];
      if (shuttles && shuttles.length > 0) {
        const match = shuttles.find(s => activeShuttle && s.id === activeShuttle.id);
        selectShuttle(match || shuttles[0]);
      }
    }
  } catch (err) {
    showToast("Connecting to Kubernetes backend...", "error");
  }
}


let turnaroundRemainingSeconds = 1800; // 30 mins (15 mins x 2 round-trip turnaround)
let turnaroundInterval = null;
let autoRedirectTimeout = null;

function startTurnaroundTimer() {
  if (turnaroundDivider) turnaroundDivider.style.display = "block";
  if (turnaroundStatCell) turnaroundStatCell.style.display = "block";

  if (turnaroundInterval) return;

  turnaroundInterval = setInterval(() => {
    turnaroundRemainingSeconds--;
    if (turnaroundRemainingSeconds <= 0) {
      clearInterval(turnaroundInterval);
      turnaroundInterval = null;
      turnaroundRemainingSeconds = 1800;
      showToast("🔄 Shuttle return turnaround completed! Bus refreshed for next departure cycle.", "success");
      fetch(`${API_BASE}/api/admin/reset`, { method: "POST" }).then(() => loadSeats());
      return;
    }

    const mins = Math.floor(turnaroundRemainingSeconds / 60);
    const secs = turnaroundRemainingSeconds % 60;
    const formatted = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    if (turnaroundTimerDisplay) {
      turnaroundTimerDisplay.textContent = formatted;
    }
    const liveTimerInBanner = document.getElementById("banner-turnaround-timer");
    if (liveTimerInBanner) {
      liveTimerInBanner.textContent = formatted;
    }
  }, 1000);
}

function stopTurnaroundTimer() {
  if (turnaroundInterval) {
    clearInterval(turnaroundInterval);
    turnaroundInterval = null;
  }
  turnaroundRemainingSeconds = 1800;
  if (turnaroundDivider) turnaroundDivider.style.display = "none";
  if (turnaroundStatCell) turnaroundStatCell.style.display = "none";
  if (autoRedirectTimeout) {
    clearTimeout(autoRedirectTimeout);
    autoRedirectTimeout = null;
  }
}

async function loadSeats() {
  if (!activeShuttle) return;

  try {
    const [seatsRes, availRes] = await Promise.all([
      fetch(`${API_BASE}/api/shuttles/${activeShuttle.id}/seats`),
      fetch(`${API_BASE}/api/shuttles/${activeShuttle.id}/availability`)
    ]);
    const seats = await seatsRes.json();
    const avail = await availRes.json();

    const isFullyBooked = avail.is_fully_booked;

    // Update manifest passenger count badge in driver bar
    const manifestCountEl = document.getElementById("manifest-count");
    if (manifestCountEl) {
      manifestCountEl.textContent = avail.booked_seats || 0;
    }

    if (isFullyBooked) {
      activeAvailableEl.textContent = `🚫 FULLY BOOKED`;
      activeAvailableEl.style.color = "#ef4444";
      btnLockSeat.disabled = true;
      btnConfirmBook.disabled = true;
      startTurnaroundTimer();
      showFullyBookedBanner(avail.total_seats, avail.waitlist_count || 0);
    } else {
      activeAvailableEl.textContent = `${avail.available_seats} Seats Free`;
      activeAvailableEl.style.color = "";
      stopTurnaroundTimer();
      hideFullyBookedBanner();
    }

    renderSeats(seats, isFullyBooked);
  } catch (err) {
    console.error("Error loading seats:", err);
  }
}

function showFullyBookedBanner(totalSeats, waitlistCount = 0) {
  let banner = document.getElementById("fully-booked-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fully-booked-banner";
    banner.style.cssText = `
      background: linear-gradient(135deg, #fee2e2, #fecaca);
      border: 2px solid #ef4444;
      border-radius: 12px;
      padding: 20px 24px;
      margin: 16px 0;
      text-align: center;
      font-family: inherit;
      animation: popIn 0.3s ease;
    `;
    seatGridContainer.parentNode.insertBefore(banner, seatGridContainer);
  }

  // Format current minutes and seconds for the banner clock
  const mins = Math.floor(turnaroundRemainingSeconds / 60);
  const secs = turnaroundRemainingSeconds % 60;
  const timerStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

  // Check if a Relief Shuttle already exists for this route
  const reliefBus = currentRouteShuttles.find(
    s => s.vehicle_number.includes("-RELIEF") && s.id !== activeShuttle.id
  );

  if (reliefBus) {
    // Relief bus already exists! Auto-redirect in 3.5 seconds
    banner.innerHTML = `
      <div style="font-size: 2.2rem; margin-bottom: 6px;">🚌💨</div>
      <div style="font-size: 1.25rem; font-weight: 800; color: #dc2626; margin-bottom: 4px;">
        Shuttle ${activeShuttle ? activeShuttle.vehicle_number : ""} Departed (100% Full)!
      </div>
      <div style="color: #7f1d1d; font-size: 0.88rem; max-width: 520px; margin: 0 auto 10px auto;">
        15-min campus journey underway. Round-trip turnaround return in: <strong id="banner-turnaround-timer" style="color: #dc2626; font-family: monospace; font-size: 1.05rem;">${timerStr}</strong>.
      </div>
      <div style="background: rgba(16, 185, 129, 0.15); border: 1.5px solid #10b981; border-radius: 8px; padding: 10px; margin: 12px auto; max-width: 440px; color: #065f46; font-weight: 700; font-size: 0.85rem;">
        🚀 Relief Backup Bus <strong>${reliefBus.vehicle_number}</strong> is active! Auto-switching your screen...
      </div>
      <div>
        <button type="button" id="btn-redirect-relief" class="btn-waitlist" style="background: linear-gradient(135deg, #10b981, #059669); color: #fff;">
          🚀 Switch to Surge Relief Bus Now ➔
        </button>
      </div>
    `;

    const redirectBtn = document.getElementById("btn-redirect-relief");
    if (redirectBtn) {
      redirectBtn.onclick = () => {
        if (autoRedirectTimeout) clearTimeout(autoRedirectTimeout);
        selectShuttle(reliefBus);
      };
    }

    if (!autoRedirectTimeout) {
      autoRedirectTimeout = setTimeout(() => {
        selectShuttle(reliefBus);
        showToast(`Switched to Surge Relief Bus ${reliefBus.vehicle_number}!`, "success");
      }, 3500);
    }
  } else {
    // No relief bus yet — offer auto-dispatching button
    banner.innerHTML = `
      <div style="font-size: 2.2rem; margin-bottom: 6px;">🚌❌</div>
      <div style="font-size: 1.25rem; font-weight: 800; color: #dc2626; margin-bottom: 4px;">
        Shuttle ${activeShuttle ? activeShuttle.vehicle_number : ""} is 100% Fully Booked!
      </div>
      <div style="color: #7f1d1d; font-size: 0.88rem; max-width: 520px; margin: 0 auto 10px auto;">
        All ${totalSeats} seats reserved. 15-min ride underway (Turnaround return in: <strong id="banner-turnaround-timer" style="color: #dc2626; font-family: monospace;">${timerStr}</strong>).
      </div>
      <div style="color: #991b1b; font-size: 0.82rem; margin-bottom: 12px;">
        Tap below to request surge capacity — the cloud will auto-dispatch a <strong>Relief Backup Shuttle</strong> with 24 extra seats!
      </div>
      <div>
        <button type="button" id="btn-join-waitlist" class="btn-waitlist">
          ⚡ Auto-Dispatch Surge Relief Bus (${waitlistCount}/3 in queue) ➔
        </button>
      </div>
    `;

    const waitlistBtn = document.getElementById("btn-join-waitlist");
    if (waitlistBtn) {
      waitlistBtn.onclick = handleJoinWaitlist;
    }
  }

  banner.style.display = "block";
}

async function handleJoinWaitlist() {
  const studentId = studentIdInput.value.trim() || "STUDENT_" + Math.floor(Math.random() * 9000 + 1000);
  const studentName = studentNameInput.value.trim() || "Campus Student";

  try {
    const res = await fetch(`${API_BASE}/api/shuttles/${activeShuttle.id}/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ student_id: studentId, student_name: studentName })
    });
    const data = await res.json();

    if (data.dispatched) {
      playSuccessChime();
      alert(`🚀 CLOUD ELASTICITY TRIGGERED!\n\n${data.message}`);
      
      // Refetch shuttles for current route to include the newly auto-dispatched relief bus
      const shuttlesRes = await fetch(`${API_BASE}/api/shuttles?route_id=${activeRoute.id}`);
      const shuttles = await shuttlesRes.json();
      currentRouteShuttles = shuttles || [];

      // Automatically switch to the newly dispatched relief shuttle!
      const reliefShuttle = shuttles.find(s => s.id === data.relief_shuttle_id) || shuttles[shuttles.length - 1];
      if (reliefShuttle) {
        selectShuttle(reliefShuttle);
        showToast(`🎉 Switched to relief bus ${reliefShuttle.vehicle_number}! 24 fresh seats open.`, "success");
      }
    } else {
      playTone(550, "sine", 0.15);
      showToast(data.message, "success");
      await loadSeats();
    }
  } catch (err) {
    showToast("Error joining waitlist.", "error");
  }
}

function hideFullyBookedBanner() {
  const banner = document.getElementById("fully-booked-banner");
  if (banner) banner.style.display = "none";
}


function renderSeats(seats, isFullyBooked = false) {
  seatGridContainer.innerHTML = "";

  // Group seats by row (e.g. 1A, 1B, 1C, 1D -> row 1)
  const rows = {};
  seats.forEach(seat => {
    const rowNum = seat.seat_number.slice(0, -1);
    if (!rows[rowNum]) rows[rowNum] = [];
    rows[rowNum].push(seat);
  });

  Object.keys(rows).forEach(rowNum => {
    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const rowSeats = rows[rowNum];
    const seatA = rowSeats.find(s => s.seat_number.endsWith("A"));
    const seatB = rowSeats.find(s => s.seat_number.endsWith("B"));
    const seatC = rowSeats.find(s => s.seat_number.endsWith("C"));
    const seatD = rowSeats.find(s => s.seat_number.endsWith("D"));

    if (seatA) rowDiv.appendChild(createSeatElement(seatA, isFullyBooked));
    if (seatB) rowDiv.appendChild(createSeatElement(seatB, isFullyBooked));

    // Aisle walkway space
    const aisle = document.createElement("div");
    aisle.className = "aisle-space";
    aisle.textContent = `ROW ${rowNum}`;
    rowDiv.appendChild(aisle);

    if (seatC) rowDiv.appendChild(createSeatElement(seatC, isFullyBooked));
    if (seatD) rowDiv.appendChild(createSeatElement(seatD, isFullyBooked));

    seatGridContainer.appendChild(rowDiv);
  });
}


function createSeatElement(seat, isFullyBooked = false) {
  const btn = document.createElement("button");
  btn.className = "seat-button";
  btn.dataset.seatId = seat.id;
  btn.dataset.seatNumber = seat.seat_number;

  let label = "AVAILABLE";
  if (seat.is_reserved) {
    btn.classList.add("booked");
    label = "TAKEN 👤";
    btn.disabled = true;
  } else if (seat.is_locked) {
    btn.classList.add("locked");
    label = `HELD ${seat.lock_ttl_remaining}s`;
    btn.disabled = true;
  } else if (isFullyBooked) {
    // Shuttle full but seat isn't individually reserved (e.g. race condition window) — show as unavailable
    btn.classList.add("booked");
    label = "FULL 🚫";
    btn.disabled = true;
  } else if (selectedSeat && selectedSeat.id === seat.id) {
    btn.classList.add("selected");
    label = "CHOSEN ⭐";
  }

  btn.innerHTML = `
    <span class="seat-btn-no">${seat.seat_number}</span>
    <span class="seat-btn-tag">${label}</span>
  `;

  if (!seat.is_reserved && !seat.is_locked && !isFullyBooked) {
    btn.onclick = () => selectSeat(seat);
  }

  return btn;
}


function selectSeat(seat) {
  playTone(440, "sine", 0.08); // pleasant tactile pop
  selectedSeat = seat;
  btnLockSeat.disabled = false;
  btnConfirmBook.disabled = false;
  btnLockSeat.textContent = `🔒 Hold Seat ${seat.seat_number} (30s)`;
  btnConfirmBook.textContent = `✅ Book Seat ${seat.seat_number} Now`;

  loadSeats();
}


// Provisional Lock (Redis SETNX)
btnLockSeat.addEventListener("click", async () => {
  if (!selectedSeat) return;

  const studentId = studentIdInput.value.trim();
  if (!studentId) {
    showToast("Please enter your Student ID", "error");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/seats/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seat_id: selectedSeat.id,
        student_id: studentId
      })
    });

    const data = await res.json();
    if (res.ok) {
      playTone(587.33, "triangle", 0.15);
      showToast(`Seat ${selectedSeat.seat_number} provisionally locked for 30s!`, "success");
      startLockCountdown(data.expires_in_seconds || 30);
      btnLockSeat.disabled = true;
      loadSeats();
    } else {
      playRejectSound();
      showToast(data.detail || "Seat lock conflict: another student took it!", "error");
      selectedSeat = null;
      btnLockSeat.disabled = true;
      btnConfirmBook.disabled = true;
      loadSeats();
    }
  } catch (err) {
    playRejectSound();
    showToast("Network error acquiring provisional lock.", "error");
  }
});


function startLockCountdown(seconds) {
  clearInterval(currentLockTimer);
  lockExpiresIn = seconds;
  lockStatusBox.style.display = "block";
  lockedSeatDisplay.textContent = selectedSeat.seat_number;
  lockTimerEl.textContent = lockExpiresIn;
  timerBar.style.width = "100%";

  const total = seconds;
  currentLockTimer = setInterval(() => {
    lockExpiresIn--;
    lockTimerEl.textContent = lockExpiresIn;
    const pct = (lockExpiresIn / total) * 100;
    timerBar.style.width = `${pct}%`;

    if (lockExpiresIn <= 0) {
      clearInterval(currentLockTimer);
      lockStatusBox.style.display = "none";
      playRejectSound();
      showToast(`Hold on Seat ${selectedSeat.seat_number} expired! Released to others.`, "error");
      selectedSeat = null;
      btnLockSeat.disabled = true;
      btnConfirmBook.disabled = true;
      loadSeats();
    }
  }, 1000);
}


// Confirm & Persist Booking (PostgreSQL + Lua unlock)
document.getElementById("booking-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedSeat) {
    showToast("Select an available seat first!", "error");
    return;
  }

  const studentId = studentIdInput.value.trim();
  const studentName = studentNameInput.value.trim();

  btnConfirmBook.disabled = true;
  btnConfirmBook.textContent = "Processing Transaction...";

  try {
    const res = await fetch(`${API_BASE}/api/book`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seat_id: selectedSeat.id,
        student_id: studentId,
        student_name: studentName
      })
    });

    const data = await res.json();
    if (res.status === 201) {
      clearInterval(currentLockTimer);
      lockStatusBox.style.display = "none";
      playSuccessChime();
      showToast(`🎉 Booking Confirmed! Ticket: ${data.booking_reference}`, "success");

      // Populate Boarding Pass
      tktStudentName.textContent = data.student_name;
      tktStudentId.textContent = data.student_id;
      tktSeatNo.textContent = data.seat_number;
      tktRefCode.textContent = data.booking_reference;

      // Real Scannable QR Code Generation (points directly to official verified pass URL)
      const qrImg = document.getElementById("tkt-qr-img");
      if (qrImg) {
        const busNum = activeShuttle ? activeShuttle.vehicle_number : "CAMPUS-EXPRESS-01";
        const routeName = activeRoute ? `${activeRoute.source} ➔ ${activeRoute.destination}` : "Campus Transit";
        const origin = window.location.origin;
        const verifyUrl = `${origin}/verify.html?ref=${encodeURIComponent(data.booking_reference)}&seat=${encodeURIComponent(data.seat_number)}&name=${encodeURIComponent(data.student_name)}&id=${encodeURIComponent(data.student_id)}&bus=${encodeURIComponent(busNum)}&route=${encodeURIComponent(routeName)}`;

        const qrPayload = encodeURIComponent(verifyUrl);
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${qrPayload}`;
      }

      ticketCard.style.display = "block";

      selectedSeat = null;
      btnLockSeat.disabled = true;
      btnConfirmBook.textContent = "✅ Confirm & Get Boarding Pass";
      await loadSeats();
      await checkHealth();
    } else {
      playRejectSound();
      showToast(data.detail || "Booking failed due to concurrency conflict.", "error");
      btnConfirmBook.textContent = "✅ Confirm & Get Boarding Pass";
      await loadSeats();
    }
  } catch (err) {
    playRejectSound();
    showToast("Server transaction error during booking.", "error");
    btnConfirmBook.textContent = "✅ Confirm & Get Boarding Pass";
  }
});


// Live Passenger Manifest Modal Logic
const btnViewPassengers = document.getElementById("btn-view-passengers");
const manifestModal = document.getElementById("manifest-modal");
const btnCloseManifest = document.getElementById("btn-close-manifest");
const manifestList = document.getElementById("manifest-list");
const manifestSub = document.getElementById("manifest-sub");

async function openManifest() {
  if (!activeShuttle) return;
  playTone(480, "sine", 0.08);
  manifestModal.style.display = "flex";
  manifestSub.textContent = `Real-time bookings for ${activeShuttle.vehicle_number} (${activeRoute ? activeRoute.source + " ➔ " + activeRoute.destination : ""})`;
  manifestList.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 24px;">Fetching live database roster...</div>`;

  try {
    const res = await fetch(`${API_BASE}/api/shuttles/${activeShuttle.id}/passengers`);
    const passengers = await res.json();
    if (!passengers || passengers.length === 0) {
      manifestList.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 30px;">No confirmed passengers yet. Be the first to book a seat!</div>`;
      return;
    }
    manifestList.innerHTML = "";
    passengers.forEach(p => {
      const row = document.createElement("div");
      row.className = "manifest-row";
      row.innerHTML = `
        <div class="manifest-seat-badge">${p.seat_number}</div>
        <div class="manifest-student-info">
          <div class="manifest-student-name">${p.student_name}</div>
          <div class="manifest-student-id">ID: ${p.student_id} • Ref: ${p.booking_reference}</div>
        </div>
        <div class="manifest-time">${p.created_at}</div>
      `;
      manifestList.appendChild(row);
    });
  } catch (err) {
    manifestList.innerHTML = `<div style="text-align: center; color: var(--alert-red); padding: 20px;">Error loading manifest.</div>`;
  }
}

function closeManifest() {
  manifestModal.style.display = "none";
}

if (btnViewPassengers) btnViewPassengers.onclick = openManifest;
if (btnCloseManifest) btnCloseManifest.onclick = closeManifest;
if (manifestModal) {
  manifestModal.onclick = (e) => {
    if (e.target === manifestModal) closeManifest();
  };
}


// Reset Demo
btnResetDemo.addEventListener("click", async () => {
  if (!confirm("Reset all bookings & locks for a fresh demo?")) return;

  try {
    const res = await fetch(`${API_BASE}/api/admin/reset`, { method: "POST" });
    if (res.ok) {
      clearInterval(currentLockTimer);
      lockStatusBox.style.display = "none";
      ticketCard.style.display = "none";
      selectedSeat = null;
      btnLockSeat.disabled = true;
      btnConfirmBook.disabled = true;
      playTone(600, "sine", 0.2);
      showToast("Demo reset! All 24 shuttle seats are now free.", "success");
      await loadSeats();
    }
  } catch (err) {
    showToast("Failed to reset demo.", "error");
  }
});


function showToast(msg, type = "success") {
  toastMessage.textContent = msg;
  toastMessage.className = `toast-card toast-${type}`;
  toastMessage.style.display = "block";
  setTimeout(() => {
    toastMessage.style.display = "none";
  }, 4000);
}


// Start App
checkHealth();
loadRoutesAndShuttle();

// Periodic sync every 3s
setInterval(() => {
  checkHealth();
  loadSeats();
}, 3000);
