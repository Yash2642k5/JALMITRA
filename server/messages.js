'use strict';

const config = require('./config');

/**
 * Resident-facing copy. Operator screens stay English; the people living with
 * the problem get their own language. SMS_LANGUAGE picks en, hi or both.
 *
 * Note for cost estimates: Devanagari makes an SMS Unicode, so a segment is
 * 70 characters instead of 160. "both" therefore costs more segments.
 */
const COPY = {
  notRegistered: {
    en: 'This number is not registered with Jal-Mitra. Contact your RWA volunteer to register.',
    hi: 'यह नंबर जल-मित्र में पंजीकृत नहीं है। पंजीकरण हेतु अपने RWA स्वयंसेवक से संपर्क करें।',
  },
  help: {
    en: 'Jal-Mitra: send WATER <family size>, e.g. WATER 4',
    hi: 'जल-मित्र: PAANI <परिवार के सदस्य> भेजें, जैसे PAANI 4',
  },
  noDelivery: {
    en: (w) => `No tanker is scheduled for ${w} yet. You will get a message as soon as one is.`,
    hi: (w) => `${w} के लिए अभी कोई टैंकर निर्धारित नहीं है। निर्धारित होते ही आपको संदेश मिलेगा।`,
  },
  claimsClosed: {
    en: (w) => `Claims for the ${w} tanker are closed. You will get a message when the next tanker is scheduled.`,
    hi: (w) => `${w} टैंकर के लिए बुकिंग बंद हो चुकी है। अगला टैंकर तय होने पर संदेश मिलेगा।`,
  },
  alreadyCollected: {
    en: (l) => `Already collected from this tanker. Your quota of ${l}L was dispensed.`,
    hi: (l) => `इस टैंकर से आपका पानी ले लिया गया है। आपका ${l} लीटर कोटा दिया जा चुका है।`,
  },
  alreadyClaimed: {
    en: (pin, l) => `You already claimed from this tanker. PIN: ${pin} (${l}L). Use it when the tanker arrives.`,
    hi: (pin, l) => `आप इस टैंकर से पहले ही बुकिंग कर चुके हैं। पिन: ${pin} (${l} लीटर)। टैंकर आने पर दिखाएँ।`,
  },
  capacityShort: {
    en: (free, need, w) =>
      `This tanker has only ${free}L left, short of your ${need}L quota. You are first in line for the next tanker in ${w}.`,
    hi: (free, need, w) =>
      `इस टैंकर में केवल ${free} लीटर बचा है, आपके ${need} लीटर कोटे से कम। ${w} के अगले टैंकर में आप पहले नंबर पर हैं।`,
  },
  capacityFull: {
    en: (w) => `This tanker is fully booked. You are first in line for the next tanker in ${w}.`,
    hi: (w) => `इस टैंकर की पूरी बुकिंग हो चुकी है। ${w} के अगले टैंकर में आप पहले नंबर पर हैं।`,
  },
  reserved: {
    en: (l, pin, from, to, w) =>
      `Quota Reserved: ${l}L. Your PIN: ${pin}. Tanker arrives ${from}-${to} at ${w}.`,
    hi: (l, pin, from, to, w) =>
      `कोटा आरक्षित: ${l} लीटर। आपका पिन: ${pin}। टैंकर ${w} में ${from}-${to} बजे आएगा।`,
  },
  announcement: {
    en: (w, from, to, deadline, cap) =>
      `Jal-Mitra: Tanker arriving in ${w} between ${from} and ${to}. Reply WATER <family size> by ${deadline} to reserve your quota. Tanker load ${cap}L — first claims are served until it is fully booked.`,
    hi: (w, from, to, deadline, cap) =>
      `जल-मित्र: ${w} में टैंकर ${from} से ${to} के बीच आएगा। ${deadline} तक PAANI <परिवार के सदस्य> भेजकर अपना कोटा आरक्षित करें। टैंकर क्षमता ${cap} लीटर — पूरा बुक होने तक पहले आने वालों को मिलेगा।`,
  },
  claimsClosedBroadcast: {
    en: (w) => `Jal-Mitra: Claims for the ${w} tanker are now closed.`,
    hi: (w) => `जल-मित्र: ${w} टैंकर के लिए बुकिंग अब बंद है।`,
  },
};

/** Renders a copy key in the configured language(s). */
function t(key, ...args) {
  const entry = COPY[key];
  if (!entry) return key;

  const render = (lang) => (typeof entry[lang] === 'function' ? entry[lang](...args) : entry[lang]);
  const lang = config.smsLanguage;

  if (lang === 'hi') return render('hi');
  if (lang === 'en') return render('en');
  return render('en') + '\n' + render('hi');
}

module.exports = { t, COPY };
