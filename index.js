import { db, auth } from './firebase-config.js';
import { collection, addDoc, query, where, getDocs, orderBy, limit, getCountFromServer } from "firebase/firestore";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { generateChurchCode } from './utils/helpers.js';
import { validateChurchForm } from './utils/validators.js';

let currentUser = null, currentRole = null;

const baseline = { total:160, verified:3, pending:8, districts:32, expected:1032 };

async function getActualStats() {
  const totalSnap = await getCountFromServer(collection(db, "churches"));
  const verifiedSnap = await getCountFromServer(query(collection(db, "churches"), where("status", "==", "verified")));
  const pendingSnap = await getCountFromServer(query(collection(db, "churches"), where("status", "==", "pending")));
  const allChurches = await getDocs(collection(db, "churches"));
  const districts = new Set();
  let expected = 0;
  allChurches.forEach(doc => {
    const data = doc.data();
    districts.add(data.district);
    expected += (data.expected_participants || 0);
  });
  return { total: totalSnap.data().count, verified: verifiedSnap.data().count, pending: pendingSnap.data().count, districts: districts.size, expected };
}

async function animateNumber(elementId, targetValue, duration = 800) {
  const element = document.getElementById(elementId);
  if (!element) return;
  const startValue = parseInt(element.innerText) || 0;
  if (startValue === targetValue) return;
  const startTime = performance.now();
  const update = (currentTime) => {
    const elapsed = currentTime - startTime;
    const progress = Math.min(1, elapsed / duration);
    const currentValue = Math.floor(startValue + (targetValue - startValue) * progress);
    element.innerText = currentValue;
    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.innerText = targetValue;
    }
  };
  requestAnimationFrame(update);
}

async function updateStats() {
  const actual = await getActualStats();
  const total = Math.max(actual.total, baseline.total);
  const verified = Math.max(actual.verified, baseline.verified);
  const pending = Math.max(actual.pending, baseline.pending);
  const districts = Math.max(actual.districts, baseline.districts);
  const expected = Math.max(actual.expected, baseline.expected);
  await Promise.all([
    animateNumber('totalChurches', total),
    animateNumber('verifiedChurches', verified),
    animateNumber('pendingChurches', pending),
    animateNumber('totalDistricts', districts),
    animateNumber('expectedParticipants', expected)
  ]);
}

async function showRecent() {
  const q = query(collection(db, "churches"), where("status", "==", "verified"), orderBy("verified_at", "desc"), limit(5));
  const snapshot = await getDocs(q);
  const list = document.getElementById('recentList');
  if (list) {
    list.innerHTML = snapshot.docs.map(doc => {
      const c = doc.data();
      return `<li><strong>${escapeHtml(c.name)}</strong> — ${escapeHtml(c.district)} (Code: ${c.registration_code})</li>`;
    }).join('');
  }
}

function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[m])); }

// ========== SPEECH SYNTHESIS (ELLA) ==========
function speakMessage(message) {
  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    window.speechSynthesis.cancel(); // Stop any ongoing speech
    window.speechSynthesis.speak(utterance);
  } else {
    console.log("Speech synthesis not supported");
  }
}

// ========== ERROR OVERLAY (ALWAYS SHOWN AFTER SUBMISSION) ==========
let errorOverlayVisible = false;

function showErrorOverlay(message = "Registration failed. Please use WhatsApp for assistance.") {
  if (errorOverlayVisible) return;
  errorOverlayVisible = true;
  
  // Speak the error message aloud (Ella)
  speakMessage(message);
  
  const overlay = document.createElement('div');
  overlay.className = 'error-overlay';
  overlay.innerHTML = `
    <h3>⚠️ ${message}</h3>
    <p>We couldn't complete your registration through the website.<br>Please contact us directly on WhatsApp.</p>
    <a href="https://wa.me/256726543986?text=Hello%2C%20I%20need%20help%20with%20church%20registration" class="whatsapp-link" target="_blank">📱 Chat on WhatsApp</a>
    <div class="close-hint">Tap anywhere to close</div>
  `;
  document.body.appendChild(overlay);
  
  const removeOverlay = () => {
    if (document.body.contains(overlay)) {
      overlay.remove();
      errorOverlayVisible = false;
      document.removeEventListener('click', removeOverlay);
      document.removeEventListener('touchstart', removeOverlay);
    }
  };
  document.addEventListener('click', removeOverlay);
  document.addEventListener('touchstart', removeOverlay);
}

// ========== FORM HANDLER (backend works, but always shows error overlay) ==========
document.getElementById('churchForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  console.log("Form submitted");

  const submitBtn = document.querySelector('#churchForm button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerText = "Submitting...";

  try {
    // Collect form data
    const formData = {
      name: document.getElementById('churchName').value.trim(),
      denomination: document.getElementById('denomination').value.trim() || null,
      district: document.getElementById('district').value,
      subcounty: document.getElementById('subcounty').value.trim(),
      parish: document.getElementById('parish').value.trim() || null,
      village: document.getElementById('village').value.trim() || null,
      pastor_name: document.getElementById('pastorName').value.trim(),
      leader_title: document.getElementById('leader').value.trim(),
      pastor_phone: document.getElementById('pastorPhone').value.trim(),
      alt_person_name: document.getElementById('altPersonName').value.trim() || null,
      alt_person_phone: document.getElementById('altPersonPhone').value.trim() || null,
      expected_participants: parseInt(document.getElementById('expectedSize').value) || 150
    };

    // Validate
    const validationError = validateChurchForm(formData);
    if (validationError) {
      showErrorOverlay(validationError);
      return;
    }

    // Duplicate check
    const q = query(collection(db, "churches"), where("name", "==", formData.name));
    const snap = await getDocs(q);
    if (!snap.empty) {
      showErrorOverlay("Church already registered. Please contact us.");
      return;
    }

    const code = await generateChurchCode(formData.district, db);

    // Firestore write
    await addDoc(collection(db, "churches"), {
      ...formData,
      registration_code: code,
      status: "pending",
      created_at: new Date().toISOString(),
      verified_at: null
    });

    // Send email via EmailJS (non‑critical)
    if (typeof emailjs !== 'undefined') {
      try {
        await emailjs.send('service_8mytg69', 'template_uqyu8p3', {
          church_name: formData.name,
          denomination: formData.denomination || "Not provided",
          district: formData.district,
          subcounty: formData.subcounty,
          parish: formData.parish || "Not provided",
          village: formData.village || "Not provided",
          pastor_name: formData.pastor_name,
          leader_title: formData.leader_title,
          pastor_phone: formData.pastor_phone,
          alt_person_name: formData.alt_person_name || "Not provided",
          alt_person_phone: formData.alt_person_phone || "Not provided",
          expected_participants: formData.expected_participants,
          registration_code: code,
          registration_date: new Date().toLocaleString()
        });
      } catch (emailErr) {
        console.error("Email error (non‑critical):", emailErr);
      }
    }

    // Always show error overlay (as requested)
    showErrorOverlay("Registration failed. Please use WhatsApp for assistance.");

    // Clear form and refresh UI
    document.getElementById('churchForm').reset();
    updateStats();
    showRecent();

  } catch (err) {
    console.error("Submission error:", err);
    showErrorOverlay("Server error. Please use WhatsApp for registration.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = "Register Church";
  }
});

// ========== ADMIN LINKS & AUTH ==========
document.getElementById('adminLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  window.location.href = 'admin/login.html';
});
document.getElementById('logoutLink')?.addEventListener('click', async (e) => {
  e.preventDefault();
  await signOut(auth);
  window.location.reload();
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    const q = query(collection(db, "user_roles"), where("user_id", "==", user.uid));
    const snap = await getDocs(q);
    if (!snap.empty) {
      currentRole = snap.docs[0].data().role;
      if (['super_admin','regional_coordinator','district_coordinator'].includes(currentRole)) {
        document.getElementById('logoutLink').style.display = 'inline';
        document.getElementById('adminPanel').style.display = 'block';
        const pendingQuery = query(collection(db, "churches"), where("status", "==", "pending"));
        const pendingSnap = await getCountFromServer(pendingQuery);
        document.getElementById('pendingSummary').innerHTML = `<p>You have ${pendingSnap.data().count} pending churches to review.</p>`;
      }
    }
  } else {
    document.getElementById('logoutLink').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'none';
  }
});

// ========== DOM READY & HELPER FUNCTIONS ==========
document.addEventListener('DOMContentLoaded', () => {
  updateStats();
  showRecent();

  // Hamburger toggle (if present)
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => navLinks.classList.toggle('show'));
  }

  // Scroll behavior for navbar
  const navbar = document.getElementById('navbar');
  if (navbar) {
    window.addEventListener('scroll', () => {
      const threshold = window.innerHeight * 0.3;
      if (window.scrollY > threshold) navbar.classList.add('scrolled');
      else navbar.classList.remove('scrolled');
    });
    window.dispatchEvent(new Event('scroll'));
  }
});

// ========== KUTESA EMMA AI ASSISTANT ==========
(function() {
  const toggleBtn = document.getElementById('aiToggleBtn');
  const chatBox = document.getElementById('aiChat');
  const closeBtn = document.getElementById('aiCloseBtn');
  const sendBtn = document.getElementById('aiSendBtn');
  const userInput = document.getElementById('aiUserInput');
  const messagesDiv = document.getElementById('aiMessages');

  if (!toggleBtn || !chatBox) {
    console.error("AI elements not found");
    return;
  }

  const knowledge = {
    'what is prayer movement': 'Prayer Movement is a collaborative initiative uniting churches, ministries, and prayer groups to pray for communities, leaders, families, and nations, culminating in a global day of worship on June 7th.',
    'june 7': 'On June 7th, believers worldwide will fill the earth with one hour of dedicated praise, worship, and intercession for our nations. Each church decides its own location and time, preferably outdoors.',
    'how to participate': 'Register your church on this website, then on June 7th gather for at least one hour of worship and prayer – indoors or outdoors. Record your session and share via WhatsApp.',
    'register church': 'Click the "Register Church" button on the homepage and fill in the form with church name, district, leader details, and expected participants.',
    'prayer points': 'We pray for: Leadership & Government, Unity & Security, Economy & Provision, Safety & Protection, Public Health, The Next Generation, The Church, Justice & Order, Families, and Thanksgiving.',
    'vision': 'Our vision is to "open the portal of worship" – shifting the spiritual atmosphere of our lands through unified praise and intercession.',
    'who can join': 'Any church, fellowship, prayer group, or individual believer can join. Registration is free and open to all.',
    'whatsapp': 'You can share your worship videos or ask questions via the floating WhatsApp button on this site.',
    'admin dashboard': 'Admins can log in to verify church registrations, view pending churches, and see a map of Uganda with registered churches.',
    'church code': 'After registration, you receive a unique church code (e.g., CH-00142-KP-3). Use it for tracking and verification.',
    'pastor': 'Church leader name and title are required fields on the registration form. Alternate contact is optional.',
    'district': 'You can select your district from the dropdown list on the registration form. All districts of Uganda are included.',
    'expected participants': 'You can estimate how many people from your church will participate in the June 7th event.',
    'verified': 'After admin approves your registration, your church status changes to "verified".'
  };

  function getAnswer(question) {
    const lowerQ = question.toLowerCase();
    for (let [key, answer] of Object.entries(knowledge)) {
      if (lowerQ.includes(key)) return answer;
    }
    const prayerKeywords = ['leadership', 'government', 'youth', 'security', 'unity', 'economy', 'family', 'health', 'church', 'justice'];
    for (let kw of prayerKeywords) {
      if (lowerQ.includes(kw)) return knowledge['prayer points'];
    }
    return "I'm sorry, I don't have that information yet. Please check the About section or contact us via WhatsApp. Remember, I am an AI and can make mistakes.";
  }

  function addMessage(text, isUser) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message ${isUser ? 'ai-user' : 'ai-bot'}`;
    msgDiv.innerText = text;
    messagesDiv.appendChild(msgDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function handleSend() {
    const question = userInput.value.trim();
    if (!question) return;
    addMessage(question, true);
    addMessage(getAnswer(question), false);
    userInput.value = '';
  }

  toggleBtn.addEventListener('click', () => {
    chatBox.style.display = chatBox.style.display === 'none' ? 'flex' : 'none';
  });
  closeBtn.addEventListener('click', () => { chatBox.style.display = 'none'; });
  sendBtn.addEventListener('click', handleSend);
  userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSend();
  });
})();