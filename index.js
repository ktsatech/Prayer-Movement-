import { db, auth } from './firebase-config.js';
import {
  collection, addDoc, query, where, getDocs,
  orderBy, limit, getCountFromServer
} from "firebase/firestore";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { generateChurchCode } from './utils/helpers.js';
import { validateChurchForm } from './utils/validators.js';

// ── EmailJS config ────────────────────────────────────────────────────────────
const EMAILJS_SERVICE_ID  = 'service_8mytg69';
const EMAILJS_TEMPLATE_ID = 'template_uqyu8p3';
const EMAILJS_PUBLIC_KEY  = 'eNR8A7R-MO9ETcLX8';
// Destination email – make sure this matches your EmailJS template "to_email" variable
const ADMIN_EMAIL = 'ktesatech.reception.co@gmail.com';

// Initialise EmailJS once
if (typeof emailjs !== 'undefined') {
  emailjs.init(EMAILJS_PUBLIC_KEY);
}

// ── Baseline stats (floor values shown even when DB is empty) ──────────────────
const baseline = { total: 160, verified: 3, pending: 8, districts: 32, expected: 1032 };

let currentUser = null;
let overlayVisible = false;

// ── Stats ──────────────────────────────────────────────────────────────────────
async function getActualStats() {
  const totalSnap    = await getCountFromServer(collection(db, "churches"));
  const verifiedSnap = await getCountFromServer(query(collection(db, "churches"), where("status", "==", "verified")));
  const pendingSnap  = await getCountFromServer(query(collection(db, "churches"), where("status", "==", "pending")));

  const allChurches = await getDocs(collection(db, "churches"));
  const districts   = new Set();
  let expected      = 0;
  allChurches.forEach(doc => {
    const d = doc.data();
    if (d.district) districts.add(d.district);
    expected += Number(d.expected_participants) || 0;
  });

  return {
    total:     totalSnap.data().count,
    verified:  verifiedSnap.data().count,
    pending:   pendingSnap.data().count,
    districts: districts.size,
    expected
  };
}

function animateNumber(elementId, target, duration = 900) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const start     = parseInt(el.textContent) || 0;
  if (start === target) return;
  const startTime = performance.now();
  const update    = now => {
    const t   = Math.min(1, (now - startTime) / duration);
    el.textContent = Math.floor(start + (target - start) * t);
    if (t < 1) requestAnimationFrame(update);
    else el.textContent = target;
  };
  requestAnimationFrame(update);
}

async function updateStats() {
  try {
    const a = await getActualStats();
    animateNumber('totalChurches',      Math.max(a.total,     baseline.total));
    animateNumber('verifiedChurches',   Math.max(a.verified,  baseline.verified));
    animateNumber('pendingChurches',    Math.max(a.pending,   baseline.pending));
    animateNumber('totalDistricts',     Math.max(a.districts, baseline.districts));
    animateNumber('expectedParticipants', Math.max(a.expected, baseline.expected));
  } catch (err) {
    console.warn("Could not fetch live stats:", err);
  }
}

async function showRecent() {
  const list = document.getElementById('recentList');
  if (!list) return;
  try {
    const q        = query(collection(db, "churches"), where("status", "==", "verified"), orderBy("verified_at", "desc"), limit(6));
    const snapshot = await getDocs(q);
    list.innerHTML = snapshot.empty
      ? '<li style="color:#6b7a8d;font-style:italic">No verified churches yet.</li>'
      : snapshot.docs.map(doc => {
          const c = doc.data();
          return `<li><strong>${esc(c.name)}</strong> — ${esc(c.district)} <span style="color:#6b7a8d;font-size:0.85rem">(${esc(c.registration_code)})</span></li>`;
        }).join('');
  } catch (err) {
    console.warn("Could not fetch recent churches:", err);
  }
}

function esc(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}

// ── Overlays ───────────────────────────────────────────────────────────────────
function showErrorOverlay(message = "Registration failed. Please use WhatsApp for assistance.") {
  if (overlayVisible) return;
  overlayVisible = true;

  const backdrop = document.createElement('div');
  backdrop.className = 'error-overlay-backdrop';

  const overlay = document.createElement('div');
  overlay.className = 'error-overlay';
  overlay.innerHTML = `
    <h3>&#9888;&#65039; ${esc(message)}</h3>
    <p>We couldn't complete your registration through the website right now.<br>Please contact us directly on WhatsApp.</p>
    <a href="https://wa.me/256726543986?text=Hello%2C%20I%20need%20help%20with%20church%20registration" class="whatsapp-link" target="_blank" rel="noopener noreferrer">&#128241; Chat on WhatsApp</a>
    <div class="close-hint">Tap anywhere to close</div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(overlay);

  const close = () => {
    backdrop.remove();
    overlay.remove();
    overlayVisible = false;
    document.removeEventListener('click', close);
    document.removeEventListener('touchstart', close);
  };
  document.addEventListener('click', close);
  document.addEventListener('touchstart', close);
}

function showSuccessOverlay(code) {
  if (overlayVisible) return;
  overlayVisible = true;

  const backdrop = document.createElement('div');
  backdrop.className = 'error-overlay-backdrop';

  const overlay = document.createElement('div');
  overlay.className = 'success-overlay';
  overlay.innerHTML = `
    <h3>&#10003; Registration Successful!</h3>
    <p>Your church has been registered and is pending verification by our admin team.</p>
    <p style="font-size:0.9rem;color:#555">Your registration code:</p>
    <div class="reg-code">${esc(code)}</div>
    <p style="font-size:0.85rem;color:#4a5568">Save this code for reference. You will be notified once verified.</p>
    <button class="close-btn" id="successCloseBtn">Close</button>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(overlay);

  const close = () => {
    backdrop.remove();
    overlay.remove();
    overlayVisible = false;
  };
  document.getElementById('successCloseBtn')?.addEventListener('click', close);
}

// ── Email via EmailJS ──────────────────────────────────────────────────────────
async function sendRegistrationEmail(formData, code) {
  if (typeof emailjs === 'undefined') return;
  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email:            ADMIN_EMAIL,
      church_name:         formData.name,
      denomination:        formData.denomination        || 'Not provided',
      district:            formData.district,
      subcounty:           formData.subcounty,
      parish:              formData.parish              || 'Not provided',
      village:             formData.village             || 'Not provided',
      pastor_name:         formData.pastor_name,
      leader_title:        formData.leader_title,
      pastor_phone:        formData.pastor_phone,
      alt_person_name:     formData.alt_person_name     || 'Not provided',
      alt_person_phone:    formData.alt_person_phone    || 'Not provided',
      expected_participants: formData.expected_participants,
      registration_code:   code,
      registration_date:   new Date().toLocaleString('en-UG', { timeZone: 'Africa/Kampala' })
    });
    console.log("Registration email sent to", ADMIN_EMAIL);
  } catch (err) {
    console.error("EmailJS error (non-critical):", err);
  }
}

// ── Form handler ───────────────────────────────────────────────────────────────
document.getElementById('churchForm')?.addEventListener('submit', async e => {
  e.preventDefault();

  const submitBtn  = document.getElementById('submitBtn');
  const msgDiv     = document.getElementById('formMessage');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';
  msgDiv.className = '';
  msgDiv.style.display = 'none';

  try {
    const formData = {
      name:                  document.getElementById('churchName').value.trim(),
      denomination:          document.getElementById('denomination').value.trim()  || null,
      district:              document.getElementById('district').value,
      subcounty:             document.getElementById('subcounty').value.trim(),
      parish:                document.getElementById('parish').value.trim()        || null,
      village:               document.getElementById('village').value.trim()       || null,
      pastor_name:           document.getElementById('pastorName').value.trim(),
      leader_title:          document.getElementById('leader').value.trim(),
      pastor_phone:          document.getElementById('pastorPhone').value.trim(),
      alt_person_name:       document.getElementById('altPersonName').value.trim() || null,
      alt_person_phone:      document.getElementById('altPersonPhone').value.trim()|| null,
      expected_participants: parseInt(document.getElementById('expectedSize').value, 10) || 150
    };

    // Client-side validation
    const validationError = validateChurchForm(formData);
    if (validationError) {
      msgDiv.textContent = validationError;
      msgDiv.className   = 'error';
      msgDiv.style.display = 'block';
      msgDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    // Duplicate check
    const dupQ    = query(collection(db, "churches"), where("name", "==", formData.name));
    const dupSnap = await getDocs(dupQ);
    if (!dupSnap.empty) {
      showErrorOverlay("This church is already registered. Contact us on WhatsApp if you need help.");
      return;
    }

    // Generate code
    const code = await generateChurchCode(formData.district, db);

    // Write to Firestore (backend always works)
    await addDoc(collection(db, "churches"), {
      ...formData,
      registration_code: code,
      status:            "pending",
      created_at:        new Date().toISOString(),
      verified_at:       null
    });

    // Send email notification (non-critical)
    await sendRegistrationEmail(formData, code);

    // Show success to user
    document.getElementById('churchForm').reset();
    showSuccessOverlay(code);
    updateStats();
    showRecent();

  } catch (err) {
    console.error("Submission error:", err);
    // Data may or may not have been saved — direct user to WhatsApp
    showErrorOverlay("A technical error occurred. Your data may not have been saved. Please register via WhatsApp.");
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = 'Register Church';
  }
});

// ── Admin link ─────────────────────────────────────────────────────────────────
document.getElementById('adminLink')?.addEventListener('click', e => {
  e.preventDefault();
  window.location.href = 'admin/login.html';
});

document.getElementById('logoutLink')?.addEventListener('click', async e => {
  e.preventDefault();
  await signOut(auth);
  window.location.reload();
});

// ── Auth state ────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (user) {
    currentUser = user;
    try {
      const q    = query(collection(db, "user_roles"), where("user_id", "==", user.uid));
      const snap = await getDocs(q);
      if (!snap.empty) {
        const role = snap.docs[0].data().role;
        if (['super_admin', 'regional_coordinator', 'district_coordinator'].includes(role)) {
          document.getElementById('logoutLink').style.display = 'inline';
          const panel = document.getElementById('adminPanel');
          if (panel) {
            panel.style.display = 'block';
            const pendingQ    = query(collection(db, "churches"), where("status", "==", "pending"));
            const pendingSnap = await getCountFromServer(pendingQ);
            const summary     = document.getElementById('pendingSummary');
            if (summary) {
              summary.innerHTML = `<p>You have <strong>${pendingSnap.data().count}</strong> pending churches to review.</p>`;
            }
          }
        }
      }
    } catch (err) {
      console.warn("Could not load admin role:", err);
    }
  } else {
    currentUser = null;
    document.getElementById('logoutLink').style.display = 'none';
    const panel = document.getElementById('adminPanel');
    if (panel) panel.style.display = 'none';
  }
});

// ── DOM ready ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateStats();
  showRecent();

  // Hamburger menu
  const hamburger = document.getElementById('hamburger');
  const navLinks  = document.getElementById('navLinks');
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => {
      const open = navLinks.classList.toggle('show');
      hamburger.setAttribute('aria-expanded', open);
    });
    // Close menu when a link is clicked
    navLinks.querySelectorAll('a').forEach(link =>
      link.addEventListener('click', () => {
        navLinks.classList.remove('show');
        hamburger.setAttribute('aria-expanded', false);
      })
    );
  }
});

// ── Kutesa Emma AI Assistant ──────────────────────────────────────────────────
(function initAI() {
  const toggleBtn  = document.getElementById('aiToggleBtn');
  const chatBox    = document.getElementById('aiChat');
  const closeBtn   = document.getElementById('aiCloseBtn');
  const sendBtn    = document.getElementById('aiSendBtn');
  const userInput  = document.getElementById('aiUserInput');
  const messages   = document.getElementById('aiMessages');

  if (!toggleBtn || !chatBox) return;

  const knowledge = {
    'prayer movement':   'Prayer Movement is a collaborative initiative uniting churches, ministries, and prayer groups to pray for communities, leaders, families, and nations, culminating in a global day of worship on June 7th.',
    'june 7':            'On June 7th, believers worldwide will fill the earth with one hour of dedicated praise, worship, and intercession for our nations. Each church decides its own location and time, preferably outdoors.',
    'how to participate':'Register your church on this website, then on June 7th gather for at least one hour of worship and prayer – indoors or outdoors. Record your session and share via WhatsApp.',
    'register':          'Click the "Register Church" button on the homepage and fill in the form with church name, district, leader details, and expected participants.',
    'prayer point':      'We pray for: Leadership & Government, Unity & Security, Economy & Provision, Safety & Protection, Public Health, The Next Generation, The Church, Justice & Order, Families, and Thanksgiving.',
    'vision':            'Our vision is to "open the portal of worship" – shifting the spiritual atmosphere of our lands through unified praise and intercession.',
    'who can join':      'Any church, fellowship, prayer group, or individual believer can join. Registration is free and open to all.',
    'whatsapp':          'You can share your worship videos or ask questions via the floating WhatsApp button on this site (+256726543986).',
    'admin':             'Admins can log in to verify church registrations, view pending churches, and manage the dashboard.',
    'church code':       'After registration, you receive a unique code (e.g. CH-00142-KA-3). Save it for tracking and verification.',
    'verified':          'After an admin approves your registration, your church status changes to "verified" and appears in the recent list.',
    'district':          'You can select your district from the dropdown on the registration form. All districts of Uganda are included.',
    'email':             'For support, contact us via WhatsApp at +256726543986 or email ktesatech.reception.co@gmail.com.',
    'error':             'If you see an error during registration, your details may still have been saved. Please contact us on WhatsApp to confirm.',
  };

  function getAnswer(question) {
    const q = question.toLowerCase();
    for (const [key, answer] of Object.entries(knowledge)) {
      if (q.includes(key)) return answer;
    }
    if (/leadership|government|youth|next gen/i.test(q)) return knowledge['prayer point'];
    if (/security|unity|peace/i.test(q))                return knowledge['prayer point'];
    if (/economy|provision|job/i.test(q))               return knowledge['prayer point'];
    if (/health|heal|medical/i.test(q))                 return knowledge['prayer point'];
    return "I'm sorry, I don't have that specific information. Please check the About section above or contact us via WhatsApp at +256726543986. Remember — I'm an AI and can make mistakes!";
  }

  function addMessage(text, isUser) {
    const div = document.createElement('div');
    div.className = `ai-message ${isUser ? 'ai-user' : 'ai-bot'}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function handleSend() {
    const q = userInput.value.trim();
    if (!q) return;
    addMessage(q, true);
    addMessage(getAnswer(q), false);
    userInput.value = '';
  }

  toggleBtn.addEventListener('click', () => {
    const open = chatBox.style.display === 'none' || chatBox.style.display === '';
    chatBox.style.display = open ? 'flex' : 'none';
    if (open) userInput.focus();
  });

  closeBtn.addEventListener('click', () => { chatBox.style.display = 'none'; });
  sendBtn.addEventListener('click', handleSend);
  userInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleSend(); });
})();
