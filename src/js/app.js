const STORE_KEY = 'invictus-security-system-v1';
const OLD_STORE_KEYS = ['pari-security-system-v1', 'beacon-sos-v3', 'beacon-sos-v2'];
const HOLD_MS = 1000;
const VOICE_COMMANDS = ['sos', 'help me', 'send alert', 'send emergency', 'emergency alert', 'invictus help'];
const DEFAULT_STATE = {
  tab: 'home',
  contacts: [],
  message: 'I need help. This is my current location.',
  battery: null,
  location: null,
  locationStatus: 'requesting',
  sosPhase: 'idle',
  log: [],
  pendingWhatsApp: false,
  voiceStatus: 'idle',
  voiceTranscript: '',
  contactError: ''
};

let holdStart = null;
let holdRAF = null;
let watchId = null;
let deferredInstallPrompt = null;
let recognition = null;
let state = loadState();

function loadState(){
  try {
    const savedState = localStorage.getItem(STORE_KEY) || OLD_STORE_KEYS.map(key=>localStorage.getItem(key)).find(Boolean);
    const saved = JSON.parse(savedState || '{}');
    return {...DEFAULT_STATE, ...saved, sosPhase:'idle', locationStatus:'requesting', pendingWhatsApp:false, voiceStatus:'idle', voiceTranscript:'', contactError:''};
  } catch {
    return {...DEFAULT_STATE};
  }
}

function saveState(){
  const {contacts, message, log} = state;
  localStorage.setItem(STORE_KEY, JSON.stringify({contacts, message, log}));
}

function fmtTime(d){
  return d.toLocaleTimeString(undefined, {hour:'2-digit', minute:'2-digit', hour12:false});
}

function fmtCoord(loc){
  if(!loc) return '- unavailable -';
  return `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`;
}

function mapsLink(loc){
  if(!loc) return '';
  return `https://maps.google.com/?q=${loc.lat},${loc.lon}`;
}

function smsPhone(phone){
  const value = Array.isArray(phone) ? phone.find(Boolean) : phone;
  const clean = String(value || '').replace(/[^\d+]/g, '');
  return clean.startsWith('+') ? `+${clean.slice(1).replace(/\D/g, '')}` : clean.replace(/\D/g, '');
}

function whatsappPhone(phone){
  const value = Array.isArray(phone) ? phone.find(Boolean) : phone;
  return String(value || '').replace(/\D/g, '');
}

function hasUsablePhone(phone){
  const digits = whatsappPhone(phone);
  return digits.length >= 8 && digits.length <= 15;
}

function cleanContactName(name, phone){
  const value = Array.isArray(name) ? name.find(Boolean) : name;
  return String(value || '').trim() || `Contact ${whatsappPhone(phone).slice(-4) || state.contacts.length + 1}`;
}

function composeAlertMessage(){
  const parts = [
    state.message.trim() || 'I need help.',
    state.location ? `Location: ${mapsLink(state.location)}` : 'Location: unavailable',
    state.battery != null ? `Battery: ${state.battery}%` : '',
    `Time: ${new Date().toLocaleString()}`
  ].filter(Boolean);
  return parts.join('\n');
}

function smsUri(phone){
  const recipients = (phone ? [phone] : state.contacts.map(c=>c.phone))
    .map(smsPhone)
    .filter(Boolean)
    .join(',');
  const separator = /iPad|iPhone|iPod/.test(navigator.userAgent) ? '&' : '?';
  return `sms:${recipients}${separator}body=${encodeURIComponent(composeAlertMessage())}`;
}

function whatsappUri(phone){
  const cleanPhone = whatsappPhone(phone);
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(composeAlertMessage())}`;
}

function getSpeechRecognition(){
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function voiceSupported(){
  return Boolean(getSpeechRecognition());
}

function isEmergencyPhrase(text){
  const phrase = text.toLowerCase();
  return VOICE_COMMANDS.some(command=>phrase.includes(command));
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function updateClock(){
  document.getElementById('clock').textContent = fmtTime(new Date());
}

setInterval(updateClock, 10000);
updateClock();

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

window.addEventListener('beforeinstallprompt', (event)=>{
  event.preventDefault();
  deferredInstallPrompt = event;
  render();
});

if('getBattery' in navigator){
  navigator.getBattery().then(b=>{
    state.battery = Math.round(b.level * 100);
    render();
    b.addEventListener('levelchange', ()=>{
      state.battery = Math.round(b.level * 100);
      render();
    });
  }).catch(()=>{
    state.battery = null;
    render();
  });
}

function requestLocation(){
  state.locationStatus = 'requesting';
  render();
  if(!('geolocation' in navigator)){
    state.locationStatus = 'unsupported';
    render();
    return;
  }
  if(watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(
    pos=>{
      state.location = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };
      state.locationStatus = 'granted';
      render();
    },
    err=>{
      state.locationStatus = err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable';
      render();
    },
    {enableHighAccuracy:true, timeout:15000, maximumAge:10000}
  );
}

requestLocation();

function render(){
  document.body.classList.toggle('alert-active', state.sosPhase === 'sending' || state.sosPhase === 'sent');
  document.getElementById('battLabel').textContent = state.battery != null ? `BATT ${state.battery}%` : 'BATT --%';
  const gpsDot = document.getElementById('gpsDot');
  const gpsLabel = document.getElementById('gpsLabel');
  if(state.locationStatus === 'granted'){
    gpsDot.classList.remove('off');
    gpsLabel.textContent = 'GPS LOCK';
  } else {
    gpsDot.classList.add('off');
    gpsLabel.textContent = state.locationStatus === 'requesting' ? 'GPS...' : 'GPS OFF';
  }

  document.querySelectorAll('.navbar button').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab === state.tab);
  });

  const c = document.getElementById('content');
  if(state.tab === 'home') c.innerHTML = renderHome();
  else if(state.tab === 'contacts') c.innerHTML = renderContacts();
  else c.innerHTML = renderLog();

  attachHandlers();
}

function renderHome(){
  let btnLabel = 'HOLD';
  let btnClass = '';
  let hint = `Press and hold <b>${(HOLD_MS/1000).toFixed(1)}s</b>. SMS opens first, then use WhatsApp buttons below.`;

  if(state.sosPhase === 'arming'){ btnLabel = 'HOLD...'; btnClass = 'armed'; hint = 'Keep holding. Release before the ring completes to cancel.'; }
  if(state.sosPhase === 'sending'){ btnLabel = 'OPENING'; btnClass = 'armed'; hint = 'Opening your phone SMS app now.'; }
  if(state.sosPhase === 'sent'){ btnLabel = 'READY'; btnClass = 'sent'; hint = '<b>SMS opened.</b> Send it, then return here for WhatsApp alerts.'; }

  const noContacts = !state.contacts.length ? `<div class="banner">Add at least one real emergency mobile number before using SOS.</div>` : '';
  const badContacts = state.contacts.some(c=>!hasUsablePhone(c.phone))
    ? `<div class="banner">Some contacts do not look like mobile numbers. Use country code format, for example 919876543210.</div>`
    : '';
  const locWarning = state.locationStatus !== 'granted'
    ? `<div class="banner">Location is ${state.locationStatus}. Use HTTPS and allow location permission. <button class="link-btn" id="retryLoc">Retry</button></div>`
    : '';
  const installBanner = deferredInstallPrompt
    ? `<div class="banner info">Install Invictus Security System on this Android phone for home-screen access. <button class="link-btn" id="installApp">Install app</button></div>`
    : '';

  return `
    ${installBanner}
    ${noContacts}
    ${badContacts}
    ${locWarning}
    <div class="sos-stage">
      <div class="ring-wrap">
        <svg class="ring" width="220" height="220" viewBox="0 0 220 220" aria-hidden="true">
          <circle class="track" cx="110" cy="110" r="100"></circle>
          <circle class="progress" id="progressRing" cx="110" cy="110" r="100" stroke-dasharray="628" stroke-dashoffset="628"></circle>
        </svg>
        <button class="sos-btn ${btnClass}" id="sosBtn" ${state.contacts.length ? '' : 'disabled'}>${btnLabel}</button>
      </div>
      <div class="hint">${hint}</div>
      ${state.sosPhase === 'sent' ? `<button class="btn-secondary" style="margin-top:14px;" id="standDown">Stand down - I'm safe</button>` : ''}
    </div>

    ${renderVoicePanel()}

    ${renderAlertPanel()}

    <div class="card">
      <div class="card-label">Alert payload</div>
      <div class="row"><span class="k">Location</span><span class="v ${state.locationStatus === 'granted' ? 'ok' : 'warn'}">${fmtCoord(state.location)}</span></div>
      <div class="row"><span class="k">Accuracy</span><span class="v">${state.location ? Math.round(state.location.accuracy) + ' m' : '-'}</span></div>
      <div class="row"><span class="k">Battery level</span><span class="v">${state.battery != null ? state.battery + '%' : '-'}</span></div>
      <div class="row"><span class="k">Sent to</span><span class="v">${state.contacts.length} contact${state.contacts.length !== 1 ? 's' : ''}</span></div>
    </div>

    <div class="card">
      <div class="card-label">Custom message</div>
      <textarea class="msg" id="msgBox" maxlength="180" placeholder="Add a short note">${escapeHtml(state.message)}</textarea>
    </div>
  `;
}

function renderVoicePanel(){
  const supported = voiceSupported();
  const listening = state.voiceStatus === 'listening';
  const heard = state.voiceTranscript ? `<div class="voice-heard">Heard: ${escapeHtml(state.voiceTranscript)}</div>` : '';
  const note = supported
    ? 'Tap Listen, then say "SOS", "help me", or "send emergency alert".'
    : 'Voice control is not supported in this browser. Use Android Chrome or install the Android app version later.';

  return `
    <div class="card voice-card">
      <div class="card-label">Voice assistant</div>
      <div class="section-note">${note}</div>
      ${heard}
      <button class="${listening ? 'btn-secondary' : 'btn-primary'}" id="voiceBtn" ${supported && state.contacts.length ? '' : 'disabled'}>
        ${listening ? 'Listening...' : 'Listen for SOS'}
      </button>
    </div>
  `;
}

function renderAlertPanel(){
  if(!state.contacts.length) return '';
  const smsLinks = state.contacts.map(ct=>{
    if(!hasUsablePhone(ct.phone)) return '';
    return `<a class="btn-secondary action-link" href="${smsUri(ct.phone)}">SMS ${escapeHtml(ct.name)}</a>`;
  }).join('');
  const whatsAppLinks = state.contacts.map(ct=>{
    const phone = whatsappPhone(ct.phone);
    if(!phone) return '';
    return `<a class="btn-whatsapp" target="_blank" rel="noopener" href="${whatsappUri(ct.phone)}">WhatsApp ${escapeHtml(ct.name)}</a>`;
  }).join('');
  const pendingNote = state.pendingWhatsApp
    ? '<div class="section-note urgent">SMS opened. After sending it, tap each WhatsApp contact below.</div>'
    : '<div class="section-note">Browsers cannot silently send emergency messages. Android will open SMS or WhatsApp with the alert filled in, then you must tap Send.</div>';

  return `
    <div class="card">
      <div class="card-label">Alert launchers</div>
      ${pendingNote}
      <a class="btn-primary action-link" href="${smsUri()}">SMS all contacts</a>
      ${smsLinks}
      ${whatsAppLinks}
    </div>
  `;
}

function renderContacts(){
  const canPick = 'contacts' in navigator && 'ContactsManager' in window;
  const error = state.contactError ? `<div class="form-error">${escapeHtml(state.contactError)}</div>` : '';
  const items = state.contacts.map((ct,i)=>`
    <div class="contact-item">
      <div class="who">
        <span class="name">${escapeHtml(ct.name)}</span>
        <span class="phone-num">${escapeHtml(ct.phone)}</span>
      </div>
      <button class="icon-btn del" data-idx="${i}" aria-label="Remove ${escapeHtml(ct.name)}">×</button>
    </div>
  `).join('');

  return `
    <div class="section-title">Emergency contacts</div>
    <div class="section-note">Use real mobile numbers with country code for WhatsApp and SMS. For India, write numbers like 919876543210. On supported Android Chrome, Import opens your phone contacts.</div>
    ${state.contacts.length ? items : '<div class="empty">No contacts yet.<br>Add at least one below.</div>'}
    <div class="add-contact">
      <input type="text" id="newName" placeholder="Name" autocomplete="name" />
      <input type="tel" id="newPhone" placeholder="Phone number with country code" autocomplete="tel" />
      ${error}
      <div class="actions">
        <button class="btn-primary" id="addContact">Add</button>
        <button class="btn-secondary" id="pickContact" ${canPick ? '' : 'disabled'}>Import</button>
      </div>
    </div>
  `;
}

function renderLog(){
  if(!state.log.length){
    return `<div class="section-title">Activity</div><div class="empty">No alerts opened yet.<br>Your SOS history will appear here.</div>`;
  }
  const items = state.log.slice().reverse().map(l=>`
    <div class="log-item">
      <div class="log-time">${escapeHtml(l.time)}</div>
      <div class="log-detail">
        Alert opened for <span class="to">${escapeHtml(l.contacts.join(', '))}</span><br>
        Location: ${escapeHtml(l.coord)}${l.msg ? `<br>"${escapeHtml(l.msg)}"` : ''}
      </div>
    </div>
  `).join('');
  return `<div class="section-title">Activity</div>${items}`;
}

function attachHandlers(){
  document.querySelectorAll('.navbar button').forEach(b=>{
    b.onclick = ()=>{
      state.tab = b.dataset.tab;
      render();
    };
  });

  const retry = document.getElementById('retryLoc');
  if(retry) retry.onclick = requestLocation;

  const install = document.getElementById('installApp');
  if(install) install.onclick = async ()=>{
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(()=>{});
    deferredInstallPrompt = null;
    render();
  };

  const msgBox = document.getElementById('msgBox');
  if(msgBox) msgBox.oninput = e=>{
    state.message = e.target.value;
    saveState();
  };

  const sosBtn = document.getElementById('sosBtn');
  if(sosBtn){
    const start = e=>{
      e.preventDefault();
      if(state.sosPhase === 'sent' || !state.contacts.length) return;
      beginHold();
    };
    const end = ()=>{
      if(state.sosPhase === 'arming') cancelHold();
    };
    sosBtn.addEventListener('pointerdown', start);
    sosBtn.addEventListener('pointerup', end);
    sosBtn.addEventListener('pointercancel', end);
    sosBtn.addEventListener('pointerleave', end);
  }

  const standDown = document.getElementById('standDown');
  if(standDown) standDown.onclick = ()=>{
    state.sosPhase = 'idle';
    state.pendingWhatsApp = false;
    state.voiceStatus = 'idle';
    render();
  };

  const voiceBtn = document.getElementById('voiceBtn');
  if(voiceBtn) voiceBtn.onclick = toggleVoiceAssistant;

  const addBtn = document.getElementById('addContact');
  if(addBtn) addBtn.onclick = addManualContact;

  const pickBtn = document.getElementById('pickContact');
  if(pickBtn) pickBtn.onclick = pickContacts;

  document.querySelectorAll('.del').forEach(b=>{
    b.onclick = ()=>{
      state.contacts.splice(Number(b.dataset.idx), 1);
      saveState();
      render();
    };
  });
}

function addManualContact(){
  const name = document.getElementById('newName').value.trim();
  const phone = document.getElementById('newPhone').value.trim();
  if(!phone){
    state.contactError = 'Enter a phone number before adding a contact.';
    render();
    return;
  }
  if(!hasUsablePhone(phone)){
    state.contactError = 'Use a valid mobile number with country code, 8 to 15 digits.';
    render();
    return;
  }
  upsertContact({name, phone});
  state.contactError = '';
  saveState();
  render();
}

function upsertContact(contact){
  const phone = smsPhone(contact.phone);
  if(!phone || !hasUsablePhone(phone)) return;
  const existing = state.contacts.find(c=>smsPhone(c.phone) === phone);
  const rawName = Array.isArray(contact.name) ? contact.name.find(Boolean) : contact.name;
  if(existing && rawName) existing.name = cleanContactName(rawName, phone);
  else if(!existing) state.contacts.push({name: cleanContactName(contact.name, phone), phone});
}

async function pickContacts(){
  if(!('contacts' in navigator)) return;
  try {
    const picked = await navigator.contacts.select(['name', 'tel'], {multiple:true});
    let valid = 0;
    picked.forEach(person=>{
      const name = cleanContactName(person.name, person.tel);
      const phones = Array.isArray(person.tel) ? person.tel : [person.tel];
      phones.filter(Boolean).forEach(phone=>{
        if(hasUsablePhone(phone)) valid += 1;
        upsertContact({name, phone});
      });
    });
    state.contactError = valid ? '' : 'No valid phone numbers were found in the selected contact.';
    saveState();
    render();
  } catch {
    render();
  }
}

function toggleVoiceAssistant(){
  if(state.voiceStatus === 'listening'){
    stopVoiceAssistant();
    return;
  }
  startVoiceAssistant();
}

function startVoiceAssistant(){
  const Recognition = getSpeechRecognition();
  if(!Recognition || !state.contacts.length) return;

  if(recognition) recognition.abort();
  recognition = new Recognition();
  recognition.lang = 'en-IN';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 3;

  state.voiceStatus = 'listening';
  state.voiceTranscript = '';
  render();

  recognition.onresult = event=>{
    const results = Array.from(event.results || []);
    const transcript = results
      .flatMap(result=>Array.from(result || []))
      .map(item=>item.transcript || '')
      .join(' ')
      .trim();

    state.voiceTranscript = transcript;
    if(isEmergencyPhrase(transcript)){
      state.voiceStatus = 'matched';
      triggerSend('voice');
    } else {
      state.voiceStatus = 'idle';
      render();
    }
  };

  recognition.onerror = ()=>{
    state.voiceStatus = 'idle';
    render();
  };

  recognition.onend = ()=>{
    if(state.voiceStatus === 'listening'){
      state.voiceStatus = 'idle';
      render();
    }
  };

  try {
    recognition.start();
  } catch {
    state.voiceStatus = 'idle';
    render();
  }
}

function stopVoiceAssistant(){
  if(recognition) recognition.abort();
  recognition = null;
  state.voiceStatus = 'idle';
  render();
}

function beginHold(){
  state.sosPhase = 'arming';
  render();
  holdStart = performance.now();
  const ring = document.getElementById('progressRing');
  const circumference = 628;
  function step(now){
    const elapsed = now - holdStart;
    const pct = Math.min(elapsed / HOLD_MS, 1);
    if(ring) ring.style.strokeDashoffset = circumference * (1 - pct);
    if(pct >= 1){
      triggerSend();
      return;
    }
    if(state.sosPhase === 'arming') holdRAF = requestAnimationFrame(step);
  }
  holdRAF = requestAnimationFrame(step);
}

function cancelHold(){
  state.sosPhase = 'idle';
  cancelAnimationFrame(holdRAF);
  render();
}

function triggerSend(source = 'hold'){
  if(state.sosPhase === 'sending' || state.sosPhase === 'sent' || !state.contacts.length) return;
  state.sosPhase = 'sending';
  state.pendingWhatsApp = true;
  render();
  state.log.push({
    time: new Date().toLocaleString(undefined, {hour:'2-digit', minute:'2-digit', hour12:false, day:'2-digit', month:'short'}),
    contacts: state.contacts.map(c=>c.name),
    coord: fmtCoord(state.location),
    msg: source === 'voice' ? `${state.message} Voice command: ${state.voiceTranscript}` : state.message
  });
  saveState();
  setTimeout(()=>{
    window.location.href = smsUri();
    state.sosPhase = 'sent';
    render();
  }, 350);
}

render();
