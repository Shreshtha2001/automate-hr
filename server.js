require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ── File upload ─────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.doc', '.docx', '.txt'].includes(
      path.extname(file.originalname).toLowerCase()
    );
    cb(ok ? null : new Error('Only PDF, DOC, DOCX, TXT files allowed'), ok);
  },
});

// ── Text extraction ──────────────────────────────
async function extractText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  try {
    if (ext === '.pdf') {
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      return data.text || '';
    }
    if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || '';
    }
    if (ext === '.txt') {
      return fs.readFileSync(filePath, 'utf8');
    }
    return '';
  } catch (err) {
    console.error('Text extraction error for', originalName, err.message);
    return '';
  }
}

// ── Extraction helpers ───────────────────────────
function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractPhone(text) {
  const m = text.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return m ? m[0].trim() : null;
}

function extractName(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  for (const line of lines.slice(0, 8)) {
    if (/^(resume|cv|curriculum|objective|summary|contact|email|phone|address|skills|experience|education|profile)/i.test(line)) continue;
    if (line.includes('@') || line.includes('http') || /\d{5}/.test(line)) continue;
    if (line.length >= 3 && line.length <= 50 && /^[A-Za-zÀ-ÖØ-öø-ÿ\s\-'.]+$/.test(line)) {
      return line.replace(/\s+/g, ' ');
    }
  }
  return 'Unknown Candidate';
}

// ── KWC area ─────────────────────────────────────
const KWC_CITIES = [
  'kitchener', 'waterloo', 'cambridge', 'guelph', 'elmira',
  'new hamburg', 'baden', 'ayr', 'paris', 'fergus', 'elora',
  'conestogo', 'st. jacobs', 'st jacobs', 'wellesley', 'linwood',
  'breslau', 'hespeler', 'prestons', 'galt', 'doon', 'branchton',
  'woolwich', 'north dumfries', 'wilmot', 'floradale', 'hawkesville',
  'millbank', 'bamberg', 'alma', 'plattsville', 'bright', 'drumbo',
  'new dundee', 'roseville', 'mannheim', 'heidelberg', 'st agatha',
];

const KWC_POSTAL_PREFIXES = [
  'n0b',
  'n1h', 'n1k', 'n1r', 'n1s', 'n1t',
  'n2a', 'n2b', 'n2c', 'n2e', 'n2g', 'n2h', 'n2j', 'n2k', 'n2l', 'n2m', 'n2n',
  'n2p', 'n2r', 'n2t', 'n2v', 'n2z',
  'n3h',
];

function hasForeignIndicator(text) {
  const tl = text.toLowerCase();
  const phrases = ['united states', 'new york', 'california', 'texas', 'florida', 'ohio',
    'michigan', 'illinois', 'united kingdom', 'new zealand', 'philippines', 'bangladesh',
    'saudi arabia', 'south africa', 'united arab'];
  if (phrases.some(f => tl.includes(f))) return true;
  const bounded = ['india', 'georgia', 'korea', 'japan', 'nigeria', 'ghana', 'kenya',
    'pakistan', 'england', 'scotland', 'australia', 'mexico', 'china'];
  if (bounded.some(f => new RegExp(`\\b${f}\\b`).test(tl))) return true;
  if (/ usa | u\.s\.a/.test(tl)) return true;
  return false;
}

// ── Universal knock-out checks ───────────────────

function checkLocation(text) {
  const tl = text.toLowerCase();
  const cityFound = KWC_CITIES.find(c => tl.includes(c));
  if (cityFound) {
    const display = cityFound.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    return { pass: true, reason: `Located in ${display} (within KWC area)`, confidence: 'high' };
  }
  const postalMatch = text.match(/\b([A-Za-z]\d[A-Za-z])\s*\d[A-Za-z]\d\b/);
  if (postalMatch) {
    const prefix = postalMatch[1].toLowerCase();
    if (KWC_POSTAL_PREFIXES.some(p => prefix === p || prefix.startsWith(p))) {
      return { pass: true, reason: `Postal code ${postalMatch[0].toUpperCase()} is within KWC area`, confidence: 'high' };
    }
    return { pass: false, reason: `Postal code ${postalMatch[0].toUpperCase()} is outside KWC 30-min radius`, confidence: 'medium' };
  }
  if (hasForeignIndicator(text)) {
    return { pass: false, reason: 'Address appears to be outside Canada', confidence: 'high' };
  }
  if (tl.includes('ontario') || /\bON\b/.test(text) || /, ON/.test(text)) {
    return { pass: false, reason: 'Ontario detected but not confirmed within KWC area', confidence: 'low', uncertain: true };
  }
  return { pass: false, reason: 'Location not found — not confirmed in KWC area', confidence: 'low', uncertain: true };
}

function checkContact(text) {
  const hasEmail = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(text);
  const hasPhone = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text);
  if (hasEmail && hasPhone) return { pass: true, reason: 'Phone and email found on resume', confidence: 'high' };
  if (hasEmail) return { pass: false, reason: 'Email found but no phone number on resume', confidence: 'high' };
  if (hasPhone) return { pass: false, reason: 'Phone found but no email on resume', confidence: 'high' };
  return { pass: false, reason: 'No phone number or email found on resume', confidence: 'high' };
}

function checkVehicle(text, role) {
  const tl = text.toLowerCase();
  const hasLicence = /driver.?s?\s*(licen[cs]e|licence)|licen[cs]ed?\s*driver|valid\s*(driver|license|licence)|class\s*[gG]\s*(driver|licen)/i.test(text);
  const hasVehicle = /\b(own\s*(vehicle|car|truck)|own\s*transportation|reliable\s*(vehicle|car|transport)|personal\s*vehicle|have\s*(a\s*)?(car|vehicle|truck))\b/i.test(text);
  const hasTransit = /\b(public\s*transit|bus|transit|grt|grand\s*river\s*transit)\b/i.test(tl);
  if (hasLicence && hasVehicle) return { pass: true, reason: "Driver's licence and own vehicle confirmed", confidence: 'high' };
  if (hasLicence) return { pass: false, reason: "Driver's licence found but own vehicle not confirmed", confidence: 'medium', uncertain: true };
  if (role === 'cleaner' && hasTransit) return { pass: true, reason: 'Reliable transit confirmed (acceptable for Cleaners)', confidence: 'medium' };
  if (hasVehicle) return { pass: false, reason: "Vehicle mentioned but driver's licence not confirmed", confidence: 'medium', uncertain: true };
  return { pass: false, reason: "Driver's licence and own vehicle not confirmed — verify in interview", confidence: 'low', uncertain: true };
}

function checkContractor(text) {
  const tl = text.toLowerCase();
  const negative = ['permanent employee', 'full-time employee', 'full time employee', 'seeking employment'];
  const positive = ['independent contractor', 'self-employed', 'self employed', 'contractor', 'freelance', 'sole proprietor', 'own business'];
  if (negative.some(n => tl.includes(n))) return { pass: false, reason: 'Resume indicates preference for employee role, not contractor', confidence: 'medium' };
  if (positive.some(p => tl.includes(p))) return { pass: true, reason: 'Open to / experienced as independent contractor', confidence: 'high' };
  return { pass: true, reason: 'Contractor preference not stated — verify in interview', confidence: 'low', uncertain: true };
}

// ── Role detection ───────────────────────────────

const HANDYMAN_KW = [
  'handyman', 'handyperson', 'handy man', 'home repair', 'home maintenance',
  'residential repair', 'residential maintenance', 'drywall', 'patching',
  'carpentry', 'trim work', 'door installation', 'painting', 'flooring',
  'caulking', 'fixture', 'furniture assembly', 'tv mounting', 'lock installation',
  'hardware installation', 'general maintenance', 'building maintenance',
  'property maintenance', 'facility maintenance', 'renovation',
];
const CLEANER_KW = [
  'cleaner', 'cleaning', 'housekeeper', 'housekeeping', 'janitor', 'janitorial',
  'maid', 'cleaning company', 'residential cleaning', 'commercial cleaning',
  'deep clean', 'move-out clean', 'airbnb', 'turnover clean', 'hotel housekeeping',
];
const ELECTRICIAN_KW = [
  'electrician', 'electrical', '309a', 'ecra', 'esa', 'lec licence',
  'licensed electrical', 'electrical contractor', 'wiring', 'panel',
  'pot lights', 'ev charger',
];
const PLUMBER_KW = [
  'plumber', 'plumbing', '306a', 'tssa', 'gas technician', 'drain',
  'water heater', 'leak repair', 'plumbing contractor',
];

function detectRole(text) {
  const tl = text.toLowerCase();
  const scores = {
    handyman:    HANDYMAN_KW.filter(kw => tl.includes(kw)).length,
    cleaner:     CLEANER_KW.filter(kw => tl.includes(kw)).length,
    electrician: ELECTRICIAN_KW.filter(kw => tl.includes(kw)).length,
    plumber:     PLUMBER_KW.filter(kw => tl.includes(kw)).length,
  };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'handyman';
}

// ── Years-of-experience helper ───────────────────

function getYearsExperience(text) {
  const patterns = [
    /(\d+)\+?\s*years?\s+(?:of\s+)?(?:experience|exp|work)/gi,
    /(?:over|more than|nearly)\s+(\d+)\s*years?/gi,
    /(\d+)\+?\s*(?:yrs?|years?)\s+(?:experience|exp)/gi,
    /(\d+)\+?\s*(?:yrs?|years?)\s+(?:in|as|of)/gi,
  ];
  let max = 0;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) { const y = parseInt(m[1]); if (y >= 1 && y < 60 && y > max) max = y; }
  }
  if (max > 0) return max;
  const now = new Date().getFullYear();
  let total = 0;
  const dateRe = /(\d{4})\s*[-–—]\s*(present|current|now|(\d{4}))/gi;
  let dm;
  while ((dm = dateRe.exec(text)) !== null) {
    const s = parseInt(dm[1]);
    const eRaw = dm[2].toLowerCase();
    const e = ['present', 'current', 'now'].includes(eRaw) ? now : parseInt(dm[3] || dm[2]);
    if (s >= 1990 && s <= now && e >= s && e <= now + 1) total += (e - s);
  }
  return total;
}

// ── Handyman knock-outs ──────────────────────────

const HANDYMAN_SKILL_AREAS = [
  { key: 'drywall/patching',       patterns: ['drywall', 'patching', 'patch', 'hole repair'] },
  { key: 'painting',               patterns: ['painting', 'painter', 'paint'] },
  { key: 'carpentry/trim',         patterns: ['carpentry', 'carpenter', 'trim', 'molding', 'millwork'] },
  { key: 'doors/locks/hardware',   patterns: ['door installation', 'door repair', 'lock installation', 'hardware installation', 'doors and locks'] },
  { key: 'tv mounting/assembly',   patterns: ['tv mounting', 'tv mount', 'furniture assembly', 'furniture build', 'tv installation'] },
  { key: 'caulking/sealing',       patterns: ['caulking', 'caulk', 'sealing', 'weatherstrip'] },
  { key: 'flooring',               patterns: ['flooring', 'hardwood floor', 'laminate floor', 'tile floor', 'floor repair'] },
  { key: 'fixture swaps',          patterns: ['fixture', 'faucet', 'toilet', 'light fixture', 'like-for-like', 'fixture replacement'] },
];

function checkHandymanKnockouts(text) {
  const tl = text.toLowerCase();
  const kos = {};

  // KO 1: 2+ years paid residential work
  const yrs = getYearsExperience(text);
  const hasPaidWork = HANDYMAN_KW.some(kw => tl.includes(kw));
  const personalOnly = /(own\s*home|my\s*house|personal\s*project|single\s*summer\s*job)/i.test(tl);
  if (!hasPaidWork || yrs < 2 || personalOnly) {
    kos.paid_experience = {
      pass: false,
      reason: !hasPaidWork ? 'No handyman/maintenance experience found'
            : personalOnly ? 'Only personal/home project work — paid work required'
            : `${yrs < 1 ? 'Under 1' : yrs} yr(s) detected — minimum 2 years paid work required`,
      confidence: yrs === 0 ? 'low' : 'high',
      uncertain: yrs === 0 && !personalOnly,
    };
  } else {
    kos.paid_experience = { pass: true, reason: `~${yrs}+ yr(s) of relevant paid work`, confidence: yrs >= 3 ? 'high' : 'medium' };
  }

  // KO 2: At least 4 skill areas
  const matched = HANDYMAN_SKILL_AREAS.filter(sa => sa.patterns.some(p => tl.includes(p)));
  kos.skill_breadth = matched.length >= 4
    ? { pass: true, reason: `${matched.length} skill area(s) confirmed: ${matched.map(s => s.key).join(', ')}`, confidence: 'high' }
    : {
        pass: false,
        reason: matched.length > 0
          ? `Only ${matched.length} of 4 required skill areas found: ${matched.map(s => s.key).join(', ')}`
          : 'No required skill areas found — needs 4 of: drywall, painting, carpentry/trim, doors/locks, TV mounting, caulking, flooring, fixture swaps',
        confidence: matched.length === 0 ? 'medium' : 'high',
      };

  // KO 3: Owns own tools
  const hasTools = /(own\s*tools|my\s*tools|personal\s*tools|bring\s*(my\s*)?tools|equipped\s*with\s*tools|provide\s*(my\s*)?own\s*tools|have\s*(my\s*)?own\s*tools)/i.test(text);
  kos.own_tools = hasTools
    ? { pass: true, reason: 'Own tools confirmed', confidence: 'high' }
    : { pass: false, reason: 'Own tools not confirmed — verify in interview', confidence: 'low', uncertain: true };

  return kos;
}

// ── Cleaner knock-outs ───────────────────────────

function checkCleanerKnockouts(text) {
  const tl = text.toLowerCase();
  const kos = {};

  const yrs = getYearsExperience(text);
  const hasCleaning = CLEANER_KW.some(kw => tl.includes(kw));
  const personalOnly = /(family\s*cleaning|cleaning\s*for\s*family|personal\s*cleaning)/i.test(tl);

  if (personalOnly) {
    kos.paid_cleaning = { pass: false, reason: 'Only personal/family cleaning — paid cleaning required', confidence: 'high' };
  } else if (!hasCleaning || yrs < 1) {
    kos.paid_cleaning = {
      pass: false,
      reason: !hasCleaning ? 'No cleaning experience found' : 'Less than 1 year of paid cleaning detected',
      confidence: yrs === 0 ? 'low' : 'medium',
      uncertain: !hasCleaning,
    };
  } else {
    kos.paid_cleaning = { pass: true, reason: `${yrs}+ yr(s) of paid cleaning experience`, confidence: 'high' };
  }

  const resTerms = ['residential cleaning', 'in-home', 'home cleaning', 'house cleaning', 'airbnb', 'move-out', 'move out clean', 'deep clean', 'residential'];
  const hasResidential = resTerms.some(t => tl.includes(t));
  const onlyCommercial = /\b(commercial\s*cleaning|office\s*cleaning|industrial\s*cleaning)\b/i.test(tl) && !hasResidential;
  kos.residential_cleaning = onlyCommercial
    ? { pass: false, reason: 'Only commercial/office cleaning — residential/in-home required', confidence: 'high' }
    : hasResidential
      ? { pass: true, reason: 'Residential/in-home cleaning confirmed', confidence: 'high' }
      : { pass: false, reason: 'Residential/in-home cleaning not confirmed — may only do offices', confidence: 'low', uncertain: true };

  return kos;
}

// ── Electrician knock-outs ───────────────────────

function checkElectricianKnockouts(text) {
  const kos = {};
  kos.cert_309a = /309\s*a|certificate\s*of\s*qualification.*electric|skilled\s*trades\s*ontario.*electric/i.test(text)
    ? { pass: true, reason: '309A Certificate of Qualification confirmed', confidence: 'high' }
    : { pass: false, reason: '309A Certificate of Qualification (Skilled Trades Ontario) not found', confidence: 'high' };

  kos.lec_licence = /ecra|esa.*licen|lec.*licen|licensed\s*electrical\s*contractor|ecra\/esa/i.test(text)
    ? { pass: true, reason: 'ECRA/ESA LEC licence confirmed', confidence: 'high' }
    : { pass: false, reason: 'ECRA/ESA Licensed Electrical Contractor (LEC) licence not found', confidence: 'high' };

  return kos;
}

// ── Plumber knock-outs ───────────────────────────

function checkPlumberKnockouts(text) {
  const kos = {};
  kos.cert_306a = /306\s*a|certificate\s*of\s*qualification.*plumb/i.test(text)
    ? { pass: true, reason: '306A Certificate of Qualification confirmed', confidence: 'high' }
    : { pass: false, reason: '306A Certificate of Qualification (compulsory trade in Ontario) not found', confidence: 'high' };

  const hasGasWork = /gas\s*(line|water\s*heater|pipe|work|install)|gas-fired|natural\s*gas/i.test(text);
  const hasTSSA = /tssa|g2\s*licen|g1\s*licen|gas\s*tech/i.test(text);
  if (hasGasWork && !hasTSSA) {
    kos.tssa_gas = { pass: false, reason: 'Gas work mentioned but TSSA gas technician licence (G2+) not found — flag for review', confidence: 'medium', uncertain: true };
  }

  return kos;
}

// ── Role scoring ─────────────────────────────────

function scoreHandyman(text) {
  const tl = text.toLowerCase();
  let score = 0;
  const breakdown = [];

  const yrs = getYearsExperience(text);
  const expPts = yrs >= 5 ? 25 : yrs >= 3 ? 18 : yrs >= 2 ? 10 : 0;
  score += expPts;
  breakdown.push({ criterion: 'Paid experience', max: 25, earned: expPts, note: `~${yrs} yrs` });

  const matched = HANDYMAN_SKILL_AREAS.filter(sa => sa.patterns.some(p => tl.includes(p)));
  const breadthPts = Math.min(Math.max(0, matched.length - 4) * 4, 20);
  score += breadthPts;
  breakdown.push({ criterion: 'Skill breadth (extra areas beyond 4)', max: 20, earned: breadthPts, note: `${matched.length} areas total` });

  const inHomePts = /(client.?s?\s*home|in-home|residential\s*client|inside\s*(client|home)|customer.?s?\s*home)/i.test(text) ? 15 : 0;
  score += inHomePts;
  breakdown.push({ criterion: 'In-home, customer-facing work', max: 15, earned: inHomePts });

  const selfPts = /(self-employed|self employed|own\s*(handyman\s*)?(business|company)|sole\s*proprietor|independent\s*contractor|freelance|side\s*jobs?\s*with)/i.test(text) ? 15 : 0;
  score += selfPts;
  breakdown.push({ criterion: 'Self-employed / ran own jobs', max: 15, earned: selfPts });

  const tradePts = /(carpentry|renovation|property\s*maintenance|millwright|industrial\s*trades?|general\s*contractor)/i.test(text) ? 10 : 0;
  score += tradePts;
  breakdown.push({ criterion: 'Related trade background', max: 10, earned: tradePts });

  let shortJobs = 0;
  const sjRe = /(\d+)\s*month/gi;
  let m;
  while ((m = sjRe.exec(text)) !== null) { if (parseInt(m[1]) < 3) shortJobs++; }
  const stabilityPts = shortJobs <= 1 ? 10 : 0;
  score += stabilityPts;
  breakdown.push({ criterion: 'Job stability', max: 10, earned: stabilityPts });

  const certsPts = /(working\s*at\s*heights|whmis|first\s*aid|cpr|safety\s*cert)/i.test(text) ? 5 : 0;
  score += certsPts;
  breakdown.push({ criterion: 'Safety certs', max: 5, earned: certsPts });

  return { score, breakdown };
}

function scoreCleaner(text) {
  const tl = text.toLowerCase();
  let score = 0;
  const breakdown = [];

  const yrs = getYearsExperience(text);
  const expPts = yrs >= 4 ? 25 : yrs >= 2 ? 18 : yrs >= 1 ? 10 : 0;
  score += expPts;
  breakdown.push({ criterion: 'Paid experience', max: 25, earned: expPts, note: `~${yrs} yrs` });

  const resTypes = ['residential', 'deep clean', 'deep-clean', 'move-out', 'move out', 'airbnb'];
  const resCount = resTypes.filter(r => tl.includes(r)).length;
  const resPts = resCount >= 2 ? 20 : resCount === 1 ? 10 : 0;
  score += resPts;
  breakdown.push({ criterion: 'Residential / deep-clean / move-out / Airbnb', max: 20, earned: resPts, note: `${resCount} type(s)` });

  const checklistPts = /(cleaning\s*company|hotel|franchise|checklist|cleaning\s*standard)/i.test(text) ? 15 : 0;
  score += checklistPts;
  breakdown.push({ criterion: 'Worked to a checklist / standard', max: 15, earned: checklistPts });

  const selfPts = /(self-employed|self employed|own\s*clients?|recurring|repeat\s*clients?|own\s*cleaning\s*business)/i.test(text) ? 15 : 0;
  score += selfPts;
  breakdown.push({ criterion: 'Self-employed with repeat clients', max: 15, earned: selfPts });

  let shortJobs = 0;
  const sjRe = /(\d+)\s*month/gi;
  let m;
  while ((m = sjRe.exec(text)) !== null) { if (parseInt(m[1]) < 3) shortJobs++; }
  const stabilityPts = shortJobs <= 1 ? 10 : 0;
  score += stabilityPts;
  breakdown.push({ criterion: 'Job stability', max: 10, earned: stabilityPts });

  const supPts = /(supervisor|trainer|team\s*lead|crew\s*lead|quality\s*control|qc|led\s*a\s*crew|trained\s*staff)/i.test(text) ? 10 : 0;
  score += supPts;
  breakdown.push({ criterion: 'Supervisor / trainer / QC role', max: 10, earned: supPts });

  const whmisPts = /(whmis|chemical\s*(handling|safety)|safety\s*training)/i.test(text) ? 5 : 0;
  score += whmisPts;
  breakdown.push({ criterion: 'WHMIS / chemical-handling training', max: 5, earned: whmisPts });

  return { score, breakdown };
}

function scoreElectrician(text) {
  let score = 0;
  const breakdown = [];

  const yrs = getYearsExperience(text);
  const expPts = yrs >= 3 ? 40 : yrs >= 1 ? 20 : 0;
  score += expPts;
  breakdown.push({ criterion: '3+ years residential service work', max: 40, earned: expPts, note: `~${yrs} yrs` });

  const lecPts = /(own\s*lec|own\s*(electrical\s*)?business|self.employed\s*electrician)/i.test(text) ? 30 : 0;
  score += lecPts;
  breakdown.push({ criterion: 'Owns their own LEC business', max: 30, earned: lecPts });

  const specialPts = /(pot\s*lights?|pot-lights?|electrical\s*panel|service\s*panel|ev\s*charger|service\s*call)/i.test(text) ? 30 : 0;
  score += specialPts;
  breakdown.push({ criterion: 'Pot lights / panels / EV chargers / service calls', max: 30, earned: specialPts });

  return { score, breakdown };
}

function scorePlumber(text) {
  let score = 0;
  const breakdown = [];

  const yrs = getYearsExperience(text);
  const expPts = yrs >= 3 ? 40 : yrs >= 1 ? 20 : 0;
  score += expPts;
  breakdown.push({ criterion: '3+ years residential service or repair', max: 40, earned: expPts, note: `~${yrs} yrs` });

  const selfPts = /(self-employed|self employed|own\s*(plumbing\s*)?business|independent\s*contractor)/i.test(text) ? 30 : 0;
  score += selfPts;
  breakdown.push({ criterion: 'Self-employed', max: 30, earned: selfPts });

  const specialPts = /(water\s*heater|fixture\s*(install|repair|replacement)|drain\s*(repair|cleaning|clog)|leak\s*repair)/i.test(text) ? 30 : 0;
  score += specialPts;
  breakdown.push({ criterion: 'Water heaters / fixtures / drain or leak repair', max: 30, earned: specialPts });

  return { score, breakdown };
}

// ── Red flags ────────────────────────────────────

function detectRedFlags(text, role) {
  const tl = text.toLowerCase();
  const flags = [];

  if (role === 'handyman') {
    if (/(electrical\s*(work|wiring|install)|wiring\s*work|panel\s*work|circuit\s*breaker)/i.test(text)
        && !/\b(309a|esa\s*licen|lec\s*licen|ecra|electrician)\b/i.test(text)) {
      flags.push('Claims electrical work without a licence — handymen cannot do electrical for OneStop (ESA rules)');
    }
    if (/(plumbing\s*work|gas\s*line|gas\s*install)/i.test(text)
        && !/\b(306a|tssa|licensed\s*plumber)\b/i.test(text)) {
      flags.push('Claims plumbing/gas work without a licence');
    }
    if (/general\s*(labour|labor)/i.test(tl)
        && !/\b(drywall|carpentry|painting|flooring|fixture|caulk|trim)\b/i.test(tl)) {
      flags.push('Only "general labour" with no specific tasks named');
    }
    if (!/\b(\d{4})\s*[-–—]\s*(present|current|now|\d{4})\b/i.test(text)) {
      flags.push('No job dates found — verify work history');
    }
  }

  if (role === 'cleaner') {
    if (/(family\s*cleaning|cleaning\s*for\s*(family|relatives)|personal\s*cleaning)/i.test(tl)) {
      flags.push('Only personal or family cleaning mentioned');
    }
    if (/\b(cleaner|cleaning)\b/i.test(tl) && /office\s*manager|project\s*manager|sales\s*representative/i.test(tl)) {
      flags.push('Job dates and titles may not align — review history manually');
    }
  }

  return flags;
}

// ── Full resume analysis ─────────────────────────
function analyzeResume(text, filename) {
  if (!text || text.trim().length < 30) {
    return {
      filename,
      name: filename.replace(/\.[^/.]+$/, ''),
      email: null,
      phone: null,
      role: 'unknown',
      score: 0,
      scoreBreakdown: [],
      redFlags: [],
      recommendation: 'Review',
      criteria: {
        location: { pass: false, reason: 'Could not extract text — manual review required', confidence: 'low', uncertain: true },
        contact:  { pass: false, reason: 'Could not extract text', confidence: 'low', uncertain: true },
      },
      status: 'review',
      shortlisted: false,
    };
  }

  const role = detectRole(text);

  const universalKOs = {
    location:   checkLocation(text),
    contact:    checkContact(text),
    vehicle:    checkVehicle(text, role),
    contractor: checkContractor(text),
  };

  let roleKOs = {};
  if (role === 'handyman')     roleKOs = checkHandymanKnockouts(text);
  else if (role === 'cleaner')     roleKOs = checkCleanerKnockouts(text);
  else if (role === 'electrician') roleKOs = checkElectricianKnockouts(text);
  else if (role === 'plumber')     roleKOs = checkPlumberKnockouts(text);

  const allKOs = { ...universalKOs, ...roleKOs };

  let scoring = { score: 0, breakdown: [] };
  if (role === 'handyman')     scoring = scoreHandyman(text);
  else if (role === 'cleaner')     scoring = scoreCleaner(text);
  else if (role === 'electrician') scoring = scoreElectrician(text);
  else if (role === 'plumber')     scoring = scorePlumber(text);

  const redFlags = detectRedFlags(text, role);

  const hardFails = Object.values(allKOs).filter(ko => !ko.pass && !ko.uncertain && ko.confidence !== 'low');
  const hasUncertain = Object.values(allKOs).some(ko => ko.uncertain || ko.confidence === 'low');

  let recommendation;
  if (hardFails.length > 0) {
    recommendation = 'Reject';
  } else if (hasUncertain || redFlags.length > 0 || scoring.score < 70) {
    recommendation = 'Review';
  } else {
    recommendation = 'Phone screen';
  }

  const status = recommendation === 'Phone screen' ? 'shortlisted'
               : recommendation === 'Review'       ? 'review'
               : 'rejected';

  return {
    filename,
    name: extractName(text),
    email: extractEmail(text),
    phone: extractPhone(text),
    role,
    score: scoring.score,
    scoreBreakdown: scoring.breakdown,
    redFlags,
    recommendation,
    knockouts: allKOs,
    criteria: allKOs,
    status,
    shortlisted: status === 'shortlisted',
  };
}

// ── Email template ───────────────────────────────
function getDeadline() {
  if (process.env.DEADLINE) return process.env.DEADLINE;
  const d = new Date();
  const daysToMon = d.getDay() === 0 ? 1 : (8 - d.getDay());
  d.setDate(d.getDate() + daysToMon);
  return d.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function buildEmailHTML(firstName, deadline) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body{font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.65;margin:0;padding:0}
  .wrap{max-width:680px;margin:0 auto;padding:28px 24px}
  h2{color:#1e40af;font-size:17px;margin-bottom:4px}
  ul,ol{padding-left:22px;margin:8px 0}
  li{margin:4px 0}
  .note{background:#eff6ff;border-left:4px solid #3b82f6;padding:10px 14px;border-radius:0 4px 4px 0;margin:16px 0;font-size:13px}
  .footer{margin-top:28px;border-top:1px solid #e2e8f0;padding-top:16px;color:#555;font-size:13px}
  strong{color:#1e293b}
</style>
</head>
<body>
<div class="wrap">
<p>Hi <strong>${firstName}</strong>,</p>
<p>Thank you for applying for the <strong>Handyman / Handyperson – Residential Home Services</strong> with <strong>OneStop KWC</strong>. We'd like to move forward with the next step in bringing you on board.</p>
<p>Before we proceed, please confirm that you have the following:</p>
<ul>
  <li>Valid contractor insurance</li>
  <li>Your own vehicle / car</li>
  <li>Your own tools required for the job</li>
  <li>Availability — please let us know what your availability looks like over the next week and/or month, including available days and approximate hours.</li>
</ul>
<div class="note">
  <strong>Note:</strong> We also noted that you currently do not have contractor insurance. Insurance will be required as you move forward with providing services through OneStop KWC, but you do not need to have the insurance in place at this stage. For now, you can proceed with reviewing and signing the agreement and completing the intake form.
</div>
<p>Please find attached the following three documents:</p>
<ol>
  <li><strong>Independent Contractor Services Agreement</strong> – The core agreement covering terms of service, compensation, and expectations.</li>
  <li><strong>Contractor Platform Standards Guide</strong> – An overview of how our platform works, including scheduling, communication, and service standards.</li>
  <li><strong>Contractor Intake Form</strong> – Please complete and return this form with your details so we can get you set up in our system.</li>
</ol>
<p>In addition, please provide the following documents / information along with your completed paperwork:</p>
<ul>
  <li><strong>Photo ID</strong> – A valid government-issued photo ID.</li>
  <li><strong>Proof of Work Eligibility</strong> – A valid work permit, Permanent Resident (PR) document/card, or Canadian citizenship document confirming your eligibility to work in Canada.</li>
  <li><strong>College Certificate</strong> – A copy of your relevant college certificate or diploma.</li>
  <li><strong>Previous Employer Reference</strong> – Contact information for a previous employer or supervisor who can provide a professional reference, including their name, company, position, and phone number / email address.</li>
</ul>
<p>Please make sure to sign the Independent Contractor Services Agreement, complete the Contractor Intake Form, and <strong>send all requested documents and information back to us by ${deadline}.</strong></p>
<p>Please reply with your insurance status, vehicle availability, tools, and availability for the coming week/month so we can determine the next steps.</p>
<p>If you have any questions about the documents or anything else, please feel free to reach out.</p>
<p>We look forward to working with you.</p>
<div class="footer">
  <p>Best regards,<br>
  <strong>OneStop KWC</strong><br>
  Human Resource Coordinator<br>
  t: +1 (780) 504-4395</p>
</div>
</div>
</body>
</html>`;
}

function buildEmailText(firstName, deadline) {
  return `Hi ${firstName},

Thank you for applying for the Handyman / Handyperson – Residential Home Services with OneStop KWC. We'd like to move forward with the next step in bringing you on board.

Before we proceed, please confirm that you have the following:
  * Valid contractor insurance
  * Your own vehicle / car
  * Your own tools required for the job
  * Availability — please let us know what your availability looks like over the next week and/or month, including available days and approximate hours.

Note: We also noted that you currently do not have contractor insurance. Insurance will be required as you move forward with providing services through OneStop KWC, but you do not need to have the insurance in place at this stage. For now, you can proceed with reviewing and signing the agreement and completing the intake form.

Please find attached the following three documents:
  1. Independent Contractor Services Agreement – The core agreement covering terms of service, compensation, and expectations.
  2. Contractor Platform Standards Guide – An overview of how our platform works, including scheduling, communication, and service standards.
  3. Contractor Intake Form – Please complete and return this form with your details so we can get you set up in our system.

In addition, please provide the following documents/information along with your completed paperwork:
  * Photo ID – A valid government-issued photo ID.
  * Proof of Work Eligibility – A valid work permit, Permanent Resident (PR) document/card, or Canadian citizenship document confirming your eligibility to work in Canada.
  * College Certificate – A copy of your relevant college certificate or diploma.
  * Previous Employer Reference – Contact information for a previous employer or supervisor who can provide a professional reference, including their name, company, position, and phone number/email address.

Please make sure to sign the Independent Contractor Services Agreement, complete the Contractor Intake Form, and send all requested documents and information back to us by ${deadline}.

Please reply with your insurance status, vehicle availability, tools, and availability for the coming week/month so we can determine the next steps.

If you have any questions about the documents or anything else, please feel free to reach out.

We look forward to working with you.

Best regards,
OneStop KWC
Human Resource Coordinator
t: +1 (780) 504-4395`;
}

// ── Template PDF attachments ─────────────────────
const TEMPLATE_DIR = path.join(__dirname, 'templates');

function buildFilePrefix(fullName) {
  return (fullName || 'Candidate')
    .replace(/[^a-zA-Z\s]/g, '')
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('_');
}

function getEffectiveDate() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  const day   = d.getDate();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year  = d.getFullYear();
  return `${day}.${month}.${year}`;
}

async function personalizeICSA(templateBuffer, candidateName, effectiveDate) {
  try {
    const doc  = await PDFDocument.load(templateBuffer, { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.getPages()[0];
    const textColor = rgb(0.102, 0.102, 0.102);
    const white     = rgb(1, 1, 1);

    // Contractor cell: original text at x=238.1 y=490.59, size 11
    page.drawRectangle({ x: 234, y: 488, width: 285, height: 20, color: white });
    page.drawText(candidateName, { x: 238.1, y: 491, size: 11, font, color: textColor });

    // Effective Date cell: original text at x=238.1 y=471.59, size 11
    page.drawRectangle({ x: 234, y: 469, width: 285, height: 20, color: white });
    page.drawText(effectiveDate, { x: 238.1, y: 472, size: 11, font, color: textColor });

    return Buffer.from(await doc.save());
  } catch (e) {
    console.warn('ICSA personalization error:', e.message);
    return templateBuffer;
  }
}

async function getTemplateAttachments(candidateName) {
  if (!fs.existsSync(TEMPLATE_DIR)) return [];
  const prefix = buildFilePrefix(candidateName || 'Candidate');
  const effectiveDate = getEffectiveDate();
  const templates = [
    { file: 'icsa.pdf',   suffix: 'ICSA',   personalize: true  },
    { file: 'guide.pdf',  suffix: 'Guide',  personalize: false },
    { file: 'intake.pdf', suffix: 'Intake', personalize: false },
  ];
  const attachments = [];
  for (const tmpl of templates) {
    const tPath = path.join(TEMPLATE_DIR, tmpl.file);
    if (!fs.existsSync(tPath)) continue;
    let content = fs.readFileSync(tPath);
    if (tmpl.personalize) {
      content = await personalizeICSA(content, candidateName || 'Candidate', effectiveDate);
    }
    attachments.push({ filename: `01_${prefix}_${tmpl.suffix}.pdf`, content, contentType: 'application/pdf' });
  }
  return attachments;
}

// ── Routes ───────────────────────────────────────
app.post('/api/upload', upload.array('resumes', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }

  const results = [];
  for (const file of req.files) {
    try {
      const text = await extractText(file.path, file.originalname);
      const analysis = analyzeResume(text, file.originalname);
      analysis.storedFilename = file.filename;
      // Embed file content as base64 so it persists in state.json regardless of server restarts
      const buf = fs.readFileSync(file.path);
      analysis.resumeBase64 = buf.toString('base64');
      analysis.resumeMimeType = file.mimetype || 'application/pdf';
      results.push(analysis);
    } catch (err) {
      results.push({
        filename: file.originalname,
        storedFilename: file.filename,
        name: file.originalname,
        email: null, phone: null,
        criteria: {},
        status: 'review',
        shortlisted: false,
        error: err.message,
      });
    }
  }

  const shortlistCount = results.filter(r => r.shortlisted).length;
  res.json({ results, total: results.length, shortlisted: shortlistCount });
});

app.post('/api/send-email', async (req, res) => {
  const { candidates, customTemplate } = req.body || {};
  if (!candidates || candidates.length === 0) {
    return res.status(400).json({ error: 'No candidates provided.' });
  }

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(503).json({ error: 'SMTP not configured. Set SMTP_USER and SMTP_PASS in your .env file.' });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const deadline = getDeadline();
  const sendResults = [];

  for (const candidate of candidates) {
    if (!candidate.email) {
      sendResults.push({ name: candidate.name, status: 'no-email', error: 'No email address found in resume' });
      continue;
    }
    const firstName = (candidate.name || 'Applicant').split(/\s+/)[0];
    const htmlBody = customTemplate
      ? customTemplate.replace(/\{\{name\}\}/g, firstName).replace(/\{\{deadline\}\}/g, deadline)
      : buildEmailHTML(firstName, deadline);
    try {
      await transporter.sendMail({
        from: `"OneStop KWC HR" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to: candidate.email,
        replyTo: process.env.SMTP_FROM || process.env.SMTP_USER,
        subject: 'Next Steps – Handyman / Handyperson at OneStop KWC',
        text: buildEmailText(firstName, deadline),
        html: htmlBody,
        attachments: await getTemplateAttachments(candidate.name),
      });
      sendResults.push({ name: candidate.name, email: candidate.email, status: 'sent' });
    } catch (err) {
      sendResults.push({ name: candidate.name, email: candidate.email, status: 'failed', error: err.message });
    }
    // small delay to avoid rate-limiting
    await new Promise(r => setTimeout(r, 300));
  }

  res.json({ results: sendResults });
});

// Return email template HTML for preview
app.get('/api/email-preview', (req, res) => {
  const rawName = req.query.name || '[Candidate Name]';
  const firstName = rawName.split(/\s+/)[0] || '[Candidate Name]';
  res.send(buildEmailHTML(firstName, getDeadline()));
});

// Return the raw default template body (for the editor)
app.get('/api/email-template-default', (req, res) => {
  res.json({ body: buildEmailHTML('{{name}}', '{{deadline}}') });
});

// ── SMTP test ────────────────────────────────────
app.get('/api/smtp-test', async (req, res) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.json({ ok: false, error: 'SMTP_USER or SMTP_PASS not set in .env' });
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  try {
    await transporter.verify();
    await transporter.sendMail({
      from: `"OneStop KWC HR" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: req.query.to || process.env.SMTP_USER,
      subject: 'Automate HR — SMTP Test',
      text: 'SMTP is working correctly.',
    });
    res.json({ ok: true, message: `Test email sent to ${req.query.to || process.env.SMTP_USER}` });
  } catch (err) {
    res.json({ ok: false, error: err.message, code: err.code });
  }
});

// ── Resume download ──────────────────────────────
app.get('/api/resume/:filename', (req, res) => {
  const uploadsDir = path.join(__dirname, 'uploads');
  const safe = path.basename(req.params.filename);
  const exactPath = path.join(uploadsDir, safe);

  if (fs.existsSync(exactPath)) return res.download(exactPath);

  // Stale storedFilename: try to find a file whose name ends with the original filename
  // storedFilename format: {timestamp}-{random}-{originalname}
  const originalName = safe.replace(/^\d+-[a-z0-9]+-/, '');
  try {
    const files = fs.readdirSync(uploadsDir);
    const match = files.find(f => f.endsWith('-' + originalName) || f === originalName);
    if (match) return res.download(path.join(uploadsDir, match));
  } catch (_) {}

  res.status(404).json({ error: 'File not found' });
});

// ── Received Documents ───────────────────────────
const RECEIVED_DIR = path.join(__dirname, 'received-docs');
const receivedUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'].includes(
      path.extname(file.originalname).toLowerCase()
    );
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

function safeFolderName(name) {
  return (name || 'Unknown').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Unknown';
}

async function verifyDocument(buffer, filename, candidateName) {
  const ext = path.extname(filename).toLowerCase();
  const issues = [];
  let text = '';
  try {
    if (ext === '.pdf') {
      const data = await pdfParse(buffer);
      text = data.text || '';
    }
  } catch { /* unreadable */ }

  if (!text) return { verified: false, issues: ['Could not extract text from document'], text: '' };

  const lower = text.toLowerCase();
  const nameParts = (candidateName || '').toLowerCase().split(/\s+/).filter(Boolean);
  const nameFound = nameParts.length > 0 && nameParts.every(p => lower.includes(p));
  if (!nameFound) issues.push('Candidate name not found in document');

  if (!/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(text)) issues.push('No date found in document');

  const isICSA = /icsa/i.test(filename) || /contractor/i.test(text);
  if (isICSA && /allan garcia/i.test(text)) issues.push('Template name "Allan Garcia" still present — not replaced');

  return { verified: issues.length === 0, issues, text: text.slice(0, 300) };
}

// OneDrive via Microsoft Graph API
async function getOneDriveToken() {
  const { ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET, ONEDRIVE_REFRESH_TOKEN } = process.env;
  if (!ONEDRIVE_CLIENT_ID || !ONEDRIVE_REFRESH_TOKEN) return null;
  try {
    const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     ONEDRIVE_CLIENT_ID,
        client_secret: ONEDRIVE_CLIENT_SECRET || '',
        refresh_token: ONEDRIVE_REFRESH_TOKEN,
        scope:         'https://graph.microsoft.com/Files.ReadWrite offline_access',
      }),
    });
    const data = await res.json();
    // Persist new refresh token if rotated
    if (data.refresh_token && data.refresh_token !== ONEDRIVE_REFRESH_TOKEN) {
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        let env = fs.readFileSync(envPath, 'utf8');
        env = env.replace(/ONEDRIVE_REFRESH_TOKEN=.*/,
          `ONEDRIVE_REFRESH_TOKEN=${data.refresh_token}`);
        fs.writeFileSync(envPath, env);
        process.env.ONEDRIVE_REFRESH_TOKEN = data.refresh_token;
      }
    }
    return data.access_token || null;
  } catch (e) {
    console.error('OneDrive token error:', e.message);
    return null;
  }
}

async function uploadToOneDrive(candidateFolderName, files) {
  const token = await getOneDriveToken();
  if (!token) return { status: 'not_configured' };

  try {
    const folderUrl = process.env.ONEDRIVE_FOLDER_URL || '';
    const encoded = Buffer.from(folderUrl).toString('base64')
      .replace(/=/g, '').replace(/\//g, '_').replace(/\+/g, '-');

    // Resolve parent folder via sharing link
    const parentRes = await fetch(
      `https://graph.microsoft.com/v1.0/shares/u!${encoded}/driveItem`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const parent = await parentRes.json();
    if (!parent.id) return { status: 'folder_not_found', detail: parent.error?.message };

    const driveId = parent.parentReference?.driveId || parent.remoteItem?.parentReference?.driveId;
    const parentId = parent.id;

    // Create candidate subfolder (ignore conflict — uses existing)
    const mkRes = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentId}/children`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: candidateFolderName,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename',
        }),
      }
    );
    const folder = await mkRes.json();
    const folderId = folder.id;
    if (!folderId) return { status: 'create_folder_failed', detail: folder.error?.message };

    const uploaded = [];
    for (const { name, buffer } of files) {
      const upRes = await fetch(
        `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/${encodeURIComponent(name)}:/content`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
          body: buffer,
        }
      );
      const upData = await upRes.json();
      if (upData.id) uploaded.push(name);
    }
    return { status: 'uploaded', uploaded };
  } catch (e) {
    console.error('OneDrive upload error:', e.message);
    return { status: 'error', detail: e.message };
  }
}

// OAuth setup — step 1: redirect to Microsoft login
app.get('/api/onedrive-folder-url', (req, res) => {
  const url = process.env.ONEDRIVE_FOLDER_URL || '';
  res.json({ url });
});

app.get('/api/setup-onedrive', (req, res) => {
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  if (!clientId) return res.status(400).send('Set ONEDRIVE_CLIENT_ID in .env first.');
  const host = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const redirect = `${protocol}://${host}/api/onedrive-callback`;
  const url = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    `client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${encodeURIComponent('Files.ReadWrite offline_access')}&response_mode=query`;
  res.redirect(url);
});

// OAuth setup — step 2: exchange code for tokens
app.get('/api/onedrive-callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`OAuth error: ${error}`);
  const clientId  = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = process.env.ONEDRIVE_CLIENT_SECRET || '';
  const host = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const redirect = `${protocol}://${host}/api/onedrive-callback`;
  try {
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId,
        client_secret: clientSecret, redirect_uri: redirect, code,
        scope: 'Files.ReadWrite offline_access',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) return res.send(`Token exchange failed: ${JSON.stringify(tokens)}`);
    const envPath = path.join(__dirname, '.env');
    let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (env.includes('ONEDRIVE_REFRESH_TOKEN=')) {
      env = env.replace(/ONEDRIVE_REFRESH_TOKEN=.*/, `ONEDRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
    } else {
      env += `\nONEDRIVE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
    }
    fs.writeFileSync(envPath, env);
    process.env.ONEDRIVE_REFRESH_TOKEN = tokens.refresh_token;
    res.send('<h2>✅ OneDrive connected! Refresh token saved. You can close this tab.</h2>');
  } catch (e) {
    res.send(`Error: ${e.message}`);
  }
});

app.post('/api/receive-docs', receivedUpload.array('docs', 20), async (req, res) => {
  const { candidateName } = req.body;
  if (!candidateName || !req.files?.length) {
    return res.status(400).json({ error: 'Candidate name and files required.' });
  }
  const folderName = safeFolderName(candidateName);
  const dir = path.join(RECEIVED_DIR, folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const results = [];
  const fileBufs = [];
  for (const file of req.files) {
    const dest = path.join(dir, file.originalname);
    fs.writeFileSync(dest, file.buffer);
    const verification = await verifyDocument(file.buffer, file.originalname, candidateName);
    results.push({ filename: file.originalname, size: file.size, ...verification });
    fileBufs.push({ name: file.originalname, buffer: file.buffer });
  }

  const oneDrive = await uploadToOneDrive(folderName, fileBufs);
  res.json({ success: true, files: results, oneDrive });
});

app.get('/api/docs-received', (req, res) => {
  if (!fs.existsSync(RECEIVED_DIR)) return res.json({ candidates: [] });
  const candidates = fs.readdirSync(RECEIVED_DIR)
    .filter(d => fs.statSync(path.join(RECEIVED_DIR, d)).isDirectory())
    .map(name => {
      const dir = path.join(RECEIVED_DIR, name);
      const files = fs.readdirSync(dir).map(f => {
        const fp = path.join(dir, f);
        return { filename: f, size: fs.statSync(fp).size, modified: fs.statSync(fp).mtime };
      });
      return { name, files };
    });
  res.json({ candidates });
});

app.get('/api/received-doc/:folder/:filename', (req, res) => {
  const folder = safeFolderName(req.params.folder);
  const file   = path.basename(req.params.filename);
  const fp     = path.join(RECEIVED_DIR, folder, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp);
});

app.delete('/api/received-doc/:folder/:filename', (req, res) => {
  const folder = safeFolderName(req.params.folder);
  const file   = path.basename(req.params.filename);
  const fp     = path.join(RECEIVED_DIR, folder, file);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

// ── Indeed IMAP watcher ──────────────────────────
const indeedApps = [];
const seenMsgIds = new Set();
const sseClients = new Set();

// SSE stream — browser connects here for real-time push
app.get('/api/indeed-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  // Send current undismissed apps immediately on connect
  res.write(`data: ${JSON.stringify({ type: 'init', apps: indeedApps.filter(a => !a.dismissed) })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/indeed-applications', (req, res) => {
  res.json({ applications: indeedApps.filter(a => !a.dismissed) });
});

app.post('/api/indeed-applications/:id/dismiss', (req, res) => {
  const found = indeedApps.find(a => a.id === req.params.id);
  if (found) found.dismissed = true;
  broadcastSSE({ type: 'dismissed', id: req.params.id });
  res.json({ ok: true });
});

function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch (_) {} });
}

function parseIndeedEmail(parsed) {
  const subject = parsed.subject || '';
  const text    = parsed.text  || '';
  const fromStr = [parsed.from?.text, parsed.from?.value?.[0]?.address].join(' ').toLowerCase();

  if (!fromStr.includes('indeed')) return null;

  let applicantName = '';
  let jobTitle      = '';

  // "John Smith applied for Handyman – Waterloo, ON"
  const m1 = subject.match(/^(.+?)\s+applied\s+for\s+(.+)$/i);
  // "New application for Handyman – Waterloo"
  const m2 = subject.match(/new\s+(?:job\s+)?application[:\s]+(.+)/i);
  const m3 = subject.match(/new\s+application\s+for\s+(.+)/i);

  if (m1) { applicantName = m1[1].trim(); jobTitle = m1[2].trim(); }
  else if (m2) { jobTitle = m2[1].trim(); }
  else if (m3) { jobTitle = m3[1].trim(); }
  else { jobTitle = subject.replace(/^re:\s*/i, '').trim(); }

  if (!applicantName) {
    const nm = text.match(/(?:applicant|candidate|name)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
    if (nm) applicantName = nm[1].trim();
  }

  const urlMatch = text.match(/https?:\/\/employers\.indeed\.com\/\S+/);
  const indeedUrl = urlMatch
    ? urlMatch[0].replace(/['"<>)\]]+$/, '')
    : 'https://employers.indeed.com/candidates';

  return {
    id:            parsed.messageId || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    applicantName: applicantName || 'New Applicant',
    jobTitle:      jobTitle      || 'Handyman Position',
    indeedUrl,
    receivedAt:    (parsed.date || new Date()).toISOString(),
    dismissed:     false,
  };
}

async function pollIndeedEmails() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  const client = new ImapFlow({
    host:   process.env.IMAP_HOST || 'imap.gmail.com',
    port:   parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      // Search by sender domain; falls back gracefully if server doesn't support it
      let uids = [];
      try {
        uids = await client.search({ from: 'indeed.com', since }, { uid: true });
      } catch (_) {
        uids = await client.search({ since }, { uid: true });
      }

      for (const uid of uids) {
        const uidKey = `uid-${uid}`;
        if (seenMsgIds.has(uidKey)) continue;

        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        const parsed = await simpleParser(msg.source);
        const msgId  = parsed.messageId || uidKey;

        if (seenMsgIds.has(msgId)) { seenMsgIds.add(uidKey); continue; }
        seenMsgIds.add(msgId);
        seenMsgIds.add(uidKey);

        const app = parseIndeedEmail(parsed);
        if (app && !indeedApps.find(a => a.id === app.id)) {
          indeedApps.unshift(app);
          broadcastSSE({ type: 'new_application', app });
          console.log(`[Indeed] ${app.applicantName} → ${app.jobTitle}`);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    if (!err.message?.includes('Connection already closed')) {
      console.error('[Indeed IMAP]', err.message);
    }
  }
}

// Poll on startup and every 60 s
pollIndeedEmails();
setInterval(pollIndeedEmails, 60 * 1000);

// ── Server-side state persistence (OneDrive-backed) ─
const DATA_DIR   = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// In-memory cache so every request doesn't hit OneDrive
let _stateCache = null;
let _stateCacheAt = 0;
const STATE_CACHE_TTL = 30_000; // 30 s

// Resolve OneDrive root folder once per session
let _odRoot = null;
async function getODRoot() {
  if (_odRoot) return _odRoot;
  const token = await getOneDriveToken();
  if (!token) return null;
  const folderUrl = process.env.ONEDRIVE_FOLDER_URL || '';
  if (!folderUrl) return null;
  const encoded = Buffer.from(folderUrl).toString('base64')
    .replace(/=/g, '').replace(/\//g, '_').replace(/\+/g, '-');
  try {
    const res  = await fetch(`https://graph.microsoft.com/v1.0/shares/u!${encoded}/driveItem`,
      { headers: { Authorization: `Bearer ${token}` } });
    const item = await res.json();
    if (!item.id) return null;
    const driveId = item.parentReference?.driveId || item.remoteItem?.parentReference?.driveId;
    _odRoot = { driveId, parentId: item.id };
    return _odRoot;
  } catch { return null; }
}

async function readStateOD() {
  try {
    const token = await getOneDriveToken();
    const root  = await getODRoot();
    if (!token || !root) return null;
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${root.driveId}/items/${root.parentId}:/_automate-hr-state.json:/content`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function writeStateOD(data) {
  try {
    const token = await getOneDriveToken();
    const root  = await getODRoot();
    if (!token || !root) return false;
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${root.driveId}/items/${root.parentId}:/_automate-hr-state.json:/content`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data) });
    return res.ok;
  } catch { return false; }
}

app.get('/api/state', async (req, res) => {
  // Serve from cache if fresh
  if (_stateCache && Date.now() - _stateCacheAt < STATE_CACHE_TTL)
    return res.json(_stateCache);
  // Try OneDrive
  const od = await readStateOD();
  if (od?.candidates) {
    _stateCache = od; _stateCacheAt = Date.now();
    return res.json(od);
  }
  // Fall back to local file
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      _stateCache = parsed; _stateCacheAt = Date.now();
      return res.json(parsed);
    }
  } catch (_) {}
  res.json({ candidates: [], emailStatus: {} });
});

app.post('/api/state', async (req, res) => {
  try {
    const { candidates, emailStatus } = req.body || {};
    const data = { candidates: candidates || [], emailStatus: emailStatus || {} };
    // Update cache immediately
    _stateCache = data; _stateCacheAt = Date.now();
    // Write local file (fast, best-effort)
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(data)); } catch (_) {}
    // Keep seed.json current so restarts always have the latest data
    try {
      const seedPath = path.join(__dirname, 'seed.json');
      const seedData = { candidates: data.candidates.map(({resumeBase64, resumeMimeType, ...rest}) => rest), emailStatus: data.emailStatus };
      fs.writeFileSync(seedPath, JSON.stringify(seedData));
    } catch (_) {}
    // Write to OneDrive in background (don't block response)
    writeStateOD(data).catch(e => console.error('[OD state]', e.message));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Startup: warm cache from OneDrive so first request is instant ──
async function warmStateCache() {
  // 1. Already have local file — use it
  if (fs.existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (parsed?.candidates?.length) {
        _stateCache = parsed; _stateCacheAt = Date.now();
        console.log(`[state] Loaded ${parsed.candidates.length} candidates from local file`);
        return;
      }
    } catch (_) {}
  }
  // 2. Try OneDrive
  const od = await readStateOD();
  if (od?.candidates?.length) {
    _stateCache = od; _stateCacheAt = Date.now();
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(od)); } catch (_) {}
    console.log(`[state] Restored ${od.candidates.length} candidates from OneDrive`);
    return;
  }
  // 3. Fall back to STATE_SEED env var (set via Render dashboard or deploy script)
  if (process.env.STATE_SEED) {
    try {
      const seed = JSON.parse(Buffer.from(process.env.STATE_SEED, 'base64').toString('utf8'));
      if (seed?.candidates?.length) {
        _stateCache = seed; _stateCacheAt = Date.now();
        try { fs.writeFileSync(STATE_FILE, JSON.stringify(seed)); } catch (_) {}
        console.log(`[state] Loaded ${seed.candidates.length} candidates from STATE_SEED env var`);
        return;
      }
    } catch (_) {}
  }
  // 4. Fall back to bundled seed file
  if (fs.existsSync(seedPath)) {
    try {
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      if (seed?.candidates?.length) {
        _stateCache = seed; _stateCacheAt = Date.now();
        try { fs.writeFileSync(STATE_FILE, JSON.stringify(seed)); } catch (_) {}
        console.log(`[state] Loaded ${seed.candidates.length} candidates from seed file`);
        return;
      }
    } catch (_) {}
  }
  console.log('[state] No saved state found — starting fresh');
}
warmStateCache().catch(e => console.error('[state warm]', e.message));

// ── Start + cleanup old uploads (>24 h) ──────────
function cleanupOldUploads() {
  const dir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  fs.readdirSync(dir).forEach(f => {
    try {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    } catch {}
  });
}
cleanupOldUploads();

app.listen(PORT, () => {
  console.log(`\n  Automate HR running at http://localhost:${PORT}\n`);
});

