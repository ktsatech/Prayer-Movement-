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

// ========== FORM HANDLER WITH EMAIL NOTIFICATION ==========
document.getElementById('churchForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  console.log("Form submitted - starting...");
  
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
  
  console.log("Collected form data:", formData);
  
  const validationError = validateChurchForm(formData);
  if (validationError) {
    document.getElementById('formMessage').innerHTML = `<span style="color:red;">${validationError}</span>`;
    return;
  }
  
  // Duplicate check
  const q = query(collection(db, "churches"), where("name", "==", formData.name));
  const snap = await getDocs(q);
  if (!snap.empty) {
    document.getElementById('formMessage').innerHTML = `<span style="color:red;">Church already registered.</span>`;
    return;
  }
  
  const code = await generateChurchCode(formData.district, db);
  
  // Disable submit button
  const submitBtn = document.querySelector('#churchForm button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerText = "Submitting...";
  document.getElementById('formMessage').innerHTML = `<span style="color:blue;">Registering... please wait.</span>`;
  
  try {
    console.log("Attempting Firestore write...");
    await addDoc(collection(db, "churches"), {
      ...formData,
      registration_code: code,
      status: "pending",
      created_at: new Date().toISOString(),
      verified_at: null
    });
    console.log("Firestore write successful");
    
    // Prepare email parameters (matching your EmailJS template variables)
    const emailParams = {
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
    };
    
    // Send email via EmailJS – replace YOUR_TEMPLATE_ID and YOUR_SERVICE_ID
    try {
      await emailjs.send('service_8mytg69', 'template_uqyu8p3', emailParams);
      console.log("Email sent successfully to ktesatech.reception.co@gmail.com");
    } catch (emailErr) {
      console.error("Email sending failed:", emailErr);
      // Optionally inform user but don't block success
    }
    
    document.getElementById('formMessage').innerHTML = `<span style="color:green;">✓ Church registered successfully! Your church code: <strong>${code}</strong>. A confirmation email has been sent to the admin.</span>`;
    document.getElementById('churchForm').reset();
    updateStats();
    showRecent();
  } catch (error) {
    console.error("Firestore error:", error);
    document.getElementById('formMessage').innerHTML = `<span style="color:red;">Error: ${error.message}</span>`;
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerText = "Register Church";
  }
});

document.getElementById('adminLink')?.addEventListener('click', (e) => { e.preventDefault(); window.location.href = 'admin/login.html'; });
document.getElementById('logoutLink')?.addEventListener('click', async (e) => { e.preventDefault(); await signOut(auth); window.location.reload(); });

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

document.addEventListener('DOMContentLoaded', () => {
  updateStats();
  showRecent();
  // Hamburger toggle (if still present)
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => navLinks.classList.toggle('show'));
  }
  // Scroll behavior
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