/* Catherine's Corner — what's new.
   A ✨ badge appears in the top bar whenever the app has updated since this
   device last looked; it opens a swipeable walkthrough of what changed, in
   user words. SHIPPING CHECKLIST for every release: add a slide (or a few)
   to RELEASES below, bump APP_VERSION + sw VERSION, deploy — the badge does
   the rest. Fresh installs never see a badge (everything is new to them). */

(function () {
  'use strict';

  const { el, esc } = UI;
  const { S, go, register } = App;

  // Newest first. Each slide: version chip, an emoji "picture", title, words.
  const RELEASES = [
    {
      v: '1.12', slides: [
        {
          art: '🎙 <span class="arrows">→</span> <span class="capart">✍️ …little <span class="hl">bear</span></span>',
          sub: 'where the browser can — always yours to fix',
          title: 'The words write themselves down',
          text: 'While you read, the app now jots the words down too (on phones whose browser can listen along). On the pages step, “✍️ Use the words I read” drops them onto the right pages — check them over, fix a word, done. Typing stays for imports and quiet browsers.',
        },
      ],
    },
    {
      v: '1.11', slides: [
        {
          art: '<span class="capart">Goodnight <span class="hl">moon</span></span>',
          sub: 'typed once — for every voice',
          title: 'Words on screen — read along',
          text: 'On the “line up the pages” step, type or paste a page’s words. At playback they sit under the picture and light up gently as the voice reads — your child follows along, and grows into reading.',
        },
        {
          art: '📷',
          sub: 'on the book’s page',
          title: 'Add a cover photo any time',
          text: 'Skipped the cover when you added a book? The book’s page now has “New cover photo” — photograph your copy whenever you like, crayon marks and all.',
        },
      ],
    },
    {
      v: '1.10', slides: [
        {
          art: '📱 <span class="arrows">⇄</span> 📱',
          sub: '📶 same WiFi',
          title: 'Two devices, one shelf — sync nearby',
          text: 'The family iPad and your phone can now match shelves directly: Keep it safe → Sync with a nearby device. A little pairing code goes between them (send it any way you like), then the recordings themselves travel over your own WiFi — nothing touches the internet.',
        },
        {
          art: '🔄',
          sub: 'nothing interrupted, nothing lost',
          title: 'Updates now arrive on their own',
          text: 'The app quietly picks up new versions when you open it and refreshes itself — never during a recording, playback, or a sync. Your recordings live safely on the device either way; an update never touches them.',
        },
        {
          art: '✨',
          sub: 'you are here — and you can always come back',
          title: 'This screen',
          text: 'After every update, the ✨ badge up top brings you here. Want it again later? Tap the version number at the very bottom of any screen, or “What’s new lately” on the grown-up home.',
        },
      ],
    },
    {
      v: '1.9', slides: [
        {
          art: '🏠 <span class="arrows">→ 📦 →</span> 🏠',
          sub: 'no account needed',
          title: 'Parcels — send a whole book to another family',
          text: 'From a book’s page, 📦 packs the pages, covers and every voice into one file, addressed to the other family’s Corner ID (theirs is under Keep it safe). They bring it in on their side and it lands on their child’s shelf, marked new.',
        },
      ],
    },
    {
      v: '1.8', slides: [
        {
          art: '📊',
          sub: 'counts only — never recordings or names',
          title: 'What gets used',
          text: 'Grown-up home → 📊 shows simple counts of what happens in the app, by area — so you (and the maker, if you share a snapshot) can see where the rough spots are.',
        },
      ],
    },
    {
      v: '1.7', slides: [
        {
          art: '<span class="pillart on">Mei</span> <span class="pillart">Theo</span>',
          sub: 'one tap on the shelf',
          title: 'Every child gets their own corner',
          text: 'Reading to more than one child? Each gets their own shelf, books and requests — the people who read are shared. Siblings switch shelves with the name pills up top.',
        },
        {
          art: '💌 <span class="arrows">→</span> 📱 <span class="arrows">→</span> 🎙',
          sub: 'grandparents, from anywhere',
          title: 'Invites that record right in the link',
          text: 'A book request now travels with a link that opens a little recording page — no app to install, no code to enter. They read, tap send, and you tuck it onto the shelf.',
        },
        {
          art: '<span class="pgart"></span><span class="pgart"></span>',
          sub: 'turn the screen sideways',
          title: 'Big picture books, both pages at once',
          text: 'Photograph large-print books as two-page spreads — half as many page turns, and in landscape both pages show big while the voice reads on.',
        },
      ],
    },
  ];

  // ---------- badge state ----------
  // The badge is keyed to the newest RELEASE with slides, not to APP_VERSION —
  // a refactor-only patch never nags anyone, and every slide-worthy release
  // badges exactly once.
  const LATEST = RELEASES[0].v;
  async function hasUnseen() {
    const [seen, ack] = await Promise.all([DB.settings.get('seenVersion'), DB.settings.get('alphaAck')]);
    if (!ack) return false;   // first run — the whole app is new, no badge needed
    if (!seen) return true;   // updated from before the badge existed
    return seen !== LATEST;
  }
  function markSeen() { return DB.settings.set('seenVersion', LATEST); }

  register('whatsnew', async function whatsNew(root) {
    await markSeen();
    root.appendChild(el(
      '<div class="kicker">fresh from the maker</div>' +
      '<h1 class="screen-title">What’s new ✨</h1>' +
      '<p class="screen-sub">Swipe through — everything that changed lately, in plain words.</p>'));

    const slides = RELEASES.flatMap(r => r.slides.map(s => ({ ...s, v: r.v })));
    const strip = el('<div class="carousel" id="strip"></div>');
    for (const s of slides) {
      strip.appendChild(el(
        '<div class="slide card">' +
        '<div class="slide-art">' + s.art + '</div>' +
        '<div class="slide-sub">' + s.sub + '</div>' +
        '<h2 class="serif slide-title">' + esc(s.title) + '</h2>' +
        '<p class="slide-text">' + esc(s.text) + '</p>' +
        '<span class="chip slide-v">v' + s.v + '</span>' +
        '</div>'));
    }
    root.appendChild(strip);

    const counter = el('<p class="hint" style="text-align:center; margin-top:10px" id="dots">1 / ' + slides.length + '</p>');
    root.appendChild(counter);
    strip.addEventListener('scroll', () => {
      const i = Math.round(strip.scrollLeft / (strip.firstElementChild.offsetWidth + 12));
      counter.textContent = Math.min(i + 1, slides.length) + ' / ' + slides.length;
    }, { passive: true });

    root.appendChild(UI.backLink('‹ back' + (S.mode === 'adult' ? ' to grown-up home' : ' to the shelf'),
      () => go(S.mode === 'adult' ? 'home' : 'shelf')));
  });

  window.WhatsNew = { hasUnseen, markSeen };
})();
