// Rule-based deal extraction: no model, no network. Reads a page's text line by
// line, tracks the surrounding "when" context (day headings, happy-hour blocks,
// time ranges) and reports each line that states an offer inside such a context.
//
// Every deal's `quote` is copied verbatim from the page, so nothing is invented;
// the trade-off is that titles and descriptions are the restaurant's own wording.

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY = "(mon|tues?|wed(?:nes|s)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:days?)?s?\\.?(?![a-z])";
const DAY_RE = new RegExp(`\\b${DAY}`, "gi");
const DAY_RANGE_RE = new RegExp(`\\b${DAY}\\s*(?:-|–|—|to|through|thru)\\s*${DAY}`, "gi");
const dayIndex = (word) => DAYS.indexOf(word.toLowerCase().slice(0, 3));

const OFFER_RE =
  /\$\s?\d+(?:\.\d{1,2})?(?:\s?off)?|\d{1,3}\s?%\s?off|half[\s-]?(?:off|priced?)|[½]\s?(?:off|price)|\b1\/2\s?(?:off|price)|\bbogo\b|buy one,? get|\b2[\s-]for[\s-]1\b|two[\s-]for[\s-]one/i;
const NOT_A_DEAL_RE =
  /\bcover\b|ticket|admission|per (?:two |2 )?(?:person|people|guest|couple)|\/\s?(?:person|per two)|corkage|\bfee\b|deposit|gift card|catering|\btray\b|donat|raffle|\bsalary\b|per hour|\/hr|rewards?\b|\bpoints\b|purchase of|\bprice:|rsvp|gratuity|\bclass\b|tasting|wine pairing|franchise|sign[\s-]?up|\bemail\b|newsletter|at the door|under 21|^add\b|chafing|upgrade|for \$\d+(?:\.\d\d)? more|\$\d+(?:\.\d\d)? more\b|\bship|per (?:half )?dozen|\/mo\b|\+\s?\$|raised|\$[\d.]+k\b|\/\s?(?:glass|bottle)|\$\d+\.\d{2}\s+-\s+\$\d+\.\d{2}/i;
// Chains list every branch's specials on one site; these are not Ann Arbor.
export const OTHER_TOWN_RE =
  /\b(?:highland|grand rapids|detroit|ypsilanti|canton|lansing|royal oak|kalamazoo|novi|plymouth|brighton|dearborn|toledo|birmingham|rochester|farmington|livonia|saline|chelsea|dexter)\b/i;
const MAX_UNDER_ONE_HEADING = 6; // more than this under one day heading is a menu
// A specific weekday (or weekdays/weekends), as opposed to "daily" / "7 days".
const WEEKDAY_NAMED_RE = new RegExp(`\\b${DAY}|\\bweekdays?\\b|\\bweekends?\\b|\\bM\\s?[-–—]\\s?F\\b`, "i");
// A calendar date: the heading is for one occasion, not every week.
const DATED_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b/i;
const HAPPY_HOUR_RE = /h[ao]ppy\s?hour/i;
// Headings that open a block of deals. A block only counts once its days and
// hours are stated, so a bare "Specials" menu tab publishes nothing.
const BLOCK_LABEL_RE =
  /h[ao]ppy\s?hour|late[\s-]?night|power hour|social hour|early bird|specials?\b|\bdeals?\b|limited[\s-]time|industry night|ladies'? night|game ?day/i;
const LABEL_REACH = 3; // lines between a block heading and the line saying when
// Offers that run for a while rather than on set weekdays.
const LIMITED_RE =
  /limited[\s-]time|for a limited|this (?:week|month) only|while supplies last|\bLTO\b|(?:ends?|through|thru|until|now through) (?:[A-Z][a-z]+\.? \d{1,2}|\d{1,2}\/\d{1,2})/i;
// Where a promo line turns into legal small print.
const FINE_PRINT_RE = /\s\|\s|\*|Limited time\.|Must be 21|Void where|Prices?,? (?:and )?participation|PRICES HIGHER|Participation may|Tax (?:&|and) gratuity/;
// On a chain's own site, an offer line with one of these is a national promotion.
const PROMO_CUE_RE =
  /\bdeals?\b|offer|coupon|\beach\b|\b\d for \$|for (?:only |just )?\$\d|\bvalue\b|bundle|combo|\bbox\b|\bmeal\b|mix (?:&|and) match|pairings?\b|carry ?out|% ?off|\$\d+(?:\.\d\d)? off|\bbogo\b|\bfree\b|\bonly\b|or less|\bnew\b/i;
const NATIONAL_NOTE = "Chain-wide offer; price and participation may vary by location";
const DEAL_WORD_RE = /happy\s?hour|special|\bdeal|discount|late night|industry night|ladies night|student/i;
const DRINK_RE =
  /beers?\b|draft|draught|pints?\b|pitcher|wines?\b|cocktail|mocktail|martini|marg(?:arita)?s?\b|drinks?\b|shots?\b|shooters?\b|mules?\b|wells?\b|whiske?y|tequila|sangria|mimosa|bloody|lager|\bales?\b|\bipa\b|spirits?|fishbowl|\bboots?\b|bottles?\b|\bmugs?\b|seltzer|vodka|bourbon|\brum\b|old fashioned|\bgin\b|spritz|daiquiri|manhattan|negroni|julep|\bsips?\b|\bcans?\b|high life|high noon|keystone|modelo|corona|\bbud\b|\bpbr\b|coffee|latte|espresso|\bchai\b|\bteas?\b|smoothie|juice|\bsoda\b|milkshake|\bshakes?\b|beverage|\bscotch\b|cognac|liqueur|mezcal|\bsake\b|soju|lemonade|\bmilk\b|sangr[ií]a|\blite\b|\bstout\b|porter\b|pilsner|cider|\bcortado|cappuccino|mocha|americano|macchiato|kombucha|\bwater\b|pop\b/i;
const FOOD_RE =
  /burger|taco|pizza|wings?\b|app(?:etizer)?s?\b|nacho|fries|sandwich|\bsubs?\b|burrito|quesadilla|chimichanga|oyster|sushi|\brolls?\b|brats?\b|bread|slider|\bdogs?\b|salad|\bbowls?\b|entree|entrée|shareable|chicken|pasta|steak|\bfood\b|\bplates?\b|dinner|lunch|brunch|breakfast|\bmeal|calzone|chipati|tender|pretzel|cheese|boards?\b|soup|noodle|bagel|donut|cookie|dessert|ice cream|creation|wrap\b|bundle|starters?\b|\bsides?\b|pastr|muffin|croissant|\bcake|\bpie\b|\begg|omelet|pancake|waffle|toast|\brice\b|curry|dumpling|\bbao\b|kebab|falafel|hummus|gyro|tamale|enchilada|empanada|\bbeans?\b|potato|onion rings|tots\b|mozz|sausage|bacon|\bham\b|turkey|\bbeef\b|\bpork\b|shrimp|salmon|\bfish\b|tofu|veggie|vegetable|kimchi|cookie|brownie|parfait|yogurt|fruit/i;

const TIME = "(\\d{1,2})(?::(\\d{2}))?\\s*(?:([ap])\\.?\\s?m\\.?)?";
const TIME_RANGE_RE = new RegExp(`${TIME}\\s*(?:-|–|—|to|until|till?)\\s*(?:${TIME}|(close|midnight))`, "i");
const TIME_UNTIL_RE = /(?:until|till?|before|open (?:to|until|till?|-|–))\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m/i;
const TIME_FROM_RE = /(?:after|from|starting at|starts at)\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m/i;

const MAX_OFFER_LINE = 180; // longer lines are prose or social captions
const MAX_PROMO_LINE = 320; // promo banners carry their small print on the same line
const CONTEXT_LINES = 8; // how far a day heading or "Happy Hour" title reaches
const MAX_DEALS_PER_PAGE = 30;

// Bump when the rules change in a way that should re-extract unchanged pages.
export const EXTRACTOR_VERSION = 8;
// A line step 3 inserts where a page <section> begins.
export const SECTION_BREAK = "§";

export function parseDays(text) {
  const found = new Set();
  // "Daily Specials" is a menu heading, not a statement that a deal runs daily.
  if (/\b(daily(?!\s+(?:specials?|menu|edition))|every\s?day|7 days|all week)\b/i.test(text)) DAYS.forEach((d) => found.add(d));
  if (/\bweekdays?\b/i.test(text) || /\bM\s?[-–—]\s?F\b/.test(text)) DAYS.slice(0, 5).forEach((d) => found.add(d));
  if (/\bweekends?\b/i.test(text)) ["sat", "sun"].forEach((d) => found.add(d));
  for (const m of text.matchAll(DAY_RANGE_RE)) {
    const from = dayIndex(m[1]);
    const to = dayIndex(m[2]);
    for (let i = from; ; i = (i + 1) % 7) {
      found.add(DAYS[i]);
      if (i === to) break;
    }
  }
  for (const m of text.matchAll(DAY_RE)) found.add(DAYS[dayIndex(m[1])]);
  return DAYS.filter((d) => found.has(d));
}

function to24(hour, minute, meridiem) {
  let h = Number(hour) % 12;
  if (meridiem.toLowerCase() === "p") h += 12;
  return `${String(h).padStart(2, "0")}:${minute ?? "00"}`;
}

export function parseTimes(text) {
  // Two different ranges on one line ("Mon-Thu 5-6PM and Fri-Sat 4-5PM") can't
  // be expressed as one window; leave the time to the description.
  if ([...text.matchAll(new RegExp(TIME_RANGE_RE, "gi"))].filter((m) => m[6] || m[7]).length > 1) return null;
  const r = text.match(TIME_RANGE_RE);
  if (r) {
    const [, h1, m1, ap1, h2, m2, ap2, word] = r;
    if (word) return ap1 ? { start: to24(h1, m1, ap1), end: word.toLowerCase() === "midnight" ? "23:59" : null } : null;
    if (!ap2) return null; // "5 - 6" with no am/pm anywhere is probably not a time
    const end = to24(h2, m2, ap2);
    let start = to24(h1, m1, ap1 ?? ap2);
    // "11-2 pm": the start borrowed "pm" but must come before the end.
    if (!ap1 && start > end) start = to24(h1, m1, ap2.toLowerCase() === "p" ? "a" : "p");
    return { start, end };
  }
  const until = text.match(TIME_UNTIL_RE);
  if (until) return { start: null, end: to24(until[1], until[2], until[3]) };
  const from = text.match(TIME_FROM_RE);
  if (from) return { start: to24(from[1], from[2], from[3]), end: null };
  return null;
}

function spanHours(time) {
  if (!time?.start || !time?.end) return 0;
  const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  return ((minutes(time.end) - minutes(time.start) + 1440) % 1440) / 60;
}

// Food, drink, or both. When the wording gives no clue, the kind of place
// decides: a bar's unnamed special is a drink, a restaurant's is food.
// `heading` (the block title, e.g. "Taco Tuesday") is consulted only when the
// deal's own words say nothing, so a margarita under it stays a drink.
export function categoryOf(text, placeType, heading = "") {
  const own = DRINK_RE.test(text) || FOOD_RE.test(text);
  const judged = own ? text : `${heading} ${text}`;
  const drink = DRINK_RE.test(judged);
  const food = FOOD_RE.test(judged);
  text = judged;
  if (drink !== food) return drink ? "drink" : "food";
  if (drink && food) return "both";
  if (HAPPY_HOUR_RE.test(text) || placeType === "cafe") return "both";
  return ["bar", "pub", "biergarten"].includes(placeType) ? "drink" : "food";
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const tidy = (s) =>
  s
    .replace(/^[\s·•✦*\-–—/|:]+|[\s·•✦*\-–—/|:]+$/g, "")
    .replace(/^image of\s+/i, "")
    .replace(/\s+/g, " ");
// A price or a discount alone on its line; what it applies to is on the line above.
const isPriceOnly = (line) => /^\$\s?\d+(?:\.\d{1,2})?(?:\s?off)?$|^\d+\.\d{2}$/i.test(line);
// A line that only says when: days and/or times and little else.
function isWhenOnly(line) {
  const rest = line
    .replace(DAY_RANGE_RE, "")
    .replace(DAY_RE, "")
    .replace(new RegExp(TIME_RANGE_RE, "gi"), "")
    .replace(/\b(daily|every\s?day|everyday|weekdays?|weekends?|every|available|from|and|through|close|[ap]\.?m\.?)\b/gi, "")
    .replace(/M\s?[-–—]\s?F/, "")
    .replace(/[\d\s:&,|/·•*\-–—.()]+/g, "")
    .replace(/(st|nd|rd|th|january|february|march|april|may|june|july|august|september|october|november|december)/gi, "");
  return rest.length <= 3;
}

// `chain`: the page belongs to a chain, so undated promo lines are national offers.
export function extractDeals(text, { chain = false } = {}) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // Sites often glue a day to what follows ("Monday$5", "FridayLate night").
  const unglue = (l) => l.replace(/(day)(?=[A-Z$])/g, "$1 ");
  const deals = [];
  // What the page has most recently said about "when", and under which title.
  let ctx = { days: [], time: null, label: null, line: -Infinity, block: [] };
  const openContext = (i, patch) => {
    ctx = { days: [], time: null, label: null, block: [], ...patch, line: i };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === SECTION_BREAK) {
      // A new page section ends a block that already has its offers. A title
      // still waiting for them is left open: sites often put the title and
      // the list in neighbouring sections.
      if (ctx.block.some((d) => d.price !== null)) openContext(-Infinity, {});
      continue;
    }
    if (line.length > 400) continue; // paragraphs of prose, not a specials list
    const days = parseDays(unglue(line));
    const time = parseTimes(line);
    // The promotional part of the line, without trailing small print.
    const head = line.split(FINE_PRINT_RE)[0].trim();
    const limited = LIMITED_RE.test(line) && OFFER_RE.test(head) && line.length <= MAX_PROMO_LINE;
    const national = chain && OFFER_RE.test(head) && PROMO_CUE_RE.test(head) && head.length <= MAX_OFFER_LINE;
    const hasOffer = !isPriceOnly(line) && ((OFFER_RE.test(line) && line.length <= MAX_OFFER_LINE) || limited || national);
    const live = i - ctx.line <= CONTEXT_LINES;
    if (!live && (ctx.days.length || ctx.label)) openContext(-Infinity, {});

    // A heading for another branch: ignore what sits under it.
    if (OTHER_TOWN_RE.test(line) && line.length <= 80) {
      openContext(i, { elsewhere: true });
      continue;
    }
    if (live && ctx.elsewhere) {
      ctx.line = hasOffer || isPriceOnly(line) ? i : ctx.line;
      continue;
    }

    // --- lines that set context rather than state an offer -------------------
    if (!hasOffer && !isPriceOnly(line)) {
      const happyHour = HAPPY_HOUR_RE.test(line);
      if (isWhenOnly(line) && (days.length || time)) {
        // A when-line directly after offers ("M–F 4PM–6PM" under a happy-hour
        // list) applies to those offers too.
        const blockNeedsWhen = live && ctx.block.length && ctx.block.every((d) => !d.days.length);
        // Days listed one per line ("THURSDAY" / "FRIDAY" / "SATURDAY") add up.
        const continuesDays = live && days.length && ctx.daysSetAt === i - 1;
        // A window of eight hours or more is opening hours, not a deal window.
        const completesLabel =
          live && ctx.label && !ctx.days.length && i - (ctx.labelLine ?? ctx.line) <= LABEL_REACH && spanHours(time) < 8;
        if (blockNeedsWhen || continuesDays || completesLabel) {
          const allDays = continuesDays ? DAYS.filter((d) => ctx.days.includes(d) || days.includes(d)) : days;
          for (const d of ctx.block) {
            if (allDays.length) d.days = allDays;
            if (time && !d.start_time && !d.end_time) Object.assign(d, { start_time: time.start, end_time: time.end });
          }
          if (allDays.length) Object.assign(ctx, { days: allDays, daysSetAt: i });
          if (time) ctx.time ??= time;
          ctx.line = i;
        } else if (days.length) {
          // A day with hours and no date is usually an opening-hours row.
          // `dayHeading`: a bare "Wednesday" or "Friday & Saturday" over a list of specials.
          openContext(i, { days, time, dated: DATED_RE.test(line), hoursLike: Boolean(time), dayHeading: !time && days.length <= 3 });
        } else if (live) {
          // A bare time under a deal belongs to that deal (or to the block).
          const last = ctx.block.at(-1);
          if (last && !last.start_time && !last.end_time && i - last._line <= 2) {
            Object.assign(last, { start_time: time.start, end_time: time.end, _timeAdjacent: i - last._line === 1 });
          } else {
            ctx.time ??= time; // "3-6pm" then "9pm-close": keep the first window
          }
          ctx.line = i;
        }
        continue;
      }
      // "Available in the bar area • Daily from open to 6:30 pm" right under a
      // block title: not a pure when-line, but it says when the block runs.
      if (
        live && ctx.label && !ctx.days.length && !happyHour &&
        i - (ctx.labelLine ?? ctx.line) <= LABEL_REACH && line.length <= 100 && days.length && time && spanHours(time) < 8
      ) {
        Object.assign(ctx, { days, time, line: i });
        for (const d of ctx.block) {
          if (!d.days.length) d.days = days;
          if (!d.start_time && !d.end_time) Object.assign(d, { start_time: time.start, end_time: time.end });
        }
        continue;
      }
      if ((happyHour && line.length <= 120) || (BLOCK_LABEL_RE.test(line) && line.length <= 60 && !days.length)) {
        // "Happy Hour" opens a block; keep the day heading it sits under.
        // Only a single-day heading ("Monday October 5th"); a range above it is
        // more likely opening hours.
        // ...or a bare day heading directly above ("Friday & Saturday" / "Happy Hour 4 - 7 pm").
        const directlyUnder = ctx.dayHeading && i - ctx.line <= 2;
        const inherited = live && !ctx.label && !ctx.hoursLike && (ctx.days.length === 1 || directlyUnder) ? ctx.days : [];
        const label = happyHour ? "Happy Hour" : tidy(line);
        openContext(i, { label, labelLine: i, days: days.length ? days : inherited, time, dated: inherited.length ? ctx.dated : false });
        if (!happyHour) continue;
        // Kept only if a time turns up, on this line or the ones right below.
        const deal = makeDeal({ line, title: "Happy Hour", days: ctx.days, time, i });
        deal.price = null;
        deal._basis = "announcement";
        deal._timeAdjacent = Boolean(time);
        deals.push(deal);
        ctx.block.push(deal);
        continue;
      }
      if (live && ctx.days.length && !ctx.label && i - ctx.line <= 1 && line.length <= 40 && !/[.!?]$/.test(line)) {
        ctx.label = tidy(line); // "Monday" / "Industry Night"
        ctx.line = i;
        continue;
      }
      if (days.length && line.length <= 60) openContext(i, { days, time, label: DEAL_WORD_RE.test(line) ? tidy(line) : null });
      continue;
    }

    // --- lines that state an offer -------------------------------------------
    let quote = line;
    if (isPriceOnly(line)) {
      // "Smash Burger" / "$8.00": the item name is on the line above.
      // Only inside a block with a stated time window; otherwise it is the
      // regular menu.
      // or under a bare day heading ("Sunday" / "Reubens" / "$12.00").
      if (!live || !(ctx.time || (ctx.dayHeading && !ctx.dated))) continue;
      const prev = lines[i - 1] ?? "";
      const next = lines[i + 1] ?? "";
      const usable = (l) => l && !OFFER_RE.test(l) && !isWhenOnly(l) && l.length <= 80;
      // Name above the price, or (price-first lists) below it.
      if (usable(prev)) quote = `${prev} ${line}`;
      else if (usable(next)) quote = `${line} ${next}`;
      else continue;
    }
    // For promo banners only the promotional part is judged, not the small print.
    const judged = limited || national ? head : quote;
    if (NOT_A_DEAL_RE.test(judged) || OTHER_TOWN_RE.test(judged)) continue;
    const inContext = live && (ctx.days.length > 0 || ctx.label);
    if (!days.length && !DEAL_WORD_RE.test(quote) && !inContext && !limited && !national) continue;

    // "Monday $5 margaritas, Happy Hour 3-6 pm": the time is the happy hour's.
    const hhAt = quote.search(HAPPY_HOUR_RE);
    const offerAt = quote.search(OFFER_RE);
    const timeIsHappyHours = time && hhAt > offerAt && offerAt >= 0 && quote.slice(hhAt).match(TIME_RANGE_RE);
    const lineDays = days.length ? days : inContext ? ctx.days : [];
    if (!lineDays.length && !(inContext && ctx.label) && !HAPPY_HOUR_RE.test(quote) && !limited && !national) continue;
    // "15% OFF" / "YOUR ORDER OF $15 OR MORE": the condition is on the next line.
    const next = lines[i + 1] ?? "";
    if ((limited || national) && quote === line && /^(?:with|your|on|when|any|all)\b/i.test(next) && next.length <= 80) {
      quote = `${head} ${next}`;
      i++;
    } else if (limited || national) {
      quote = head;
    }
    const deal = makeDeal({
      line: quote,
      // A name/price pair is titled by its own name, not the block's.
      title: isPriceOnly(line) ? null : !days.length && inContext && ctx.label ? ctx.label : null,
      days: lineDays,
      time: timeIsHappyHours ? null : (time ?? (inContext ? ctx.time : null)),
      i,
    });
    // What ties this offer to a "when": the line itself, a single-day heading
    // above it, or merely sitting in a block.
    const namesDay = WEEKDAY_NAMED_RE.test(unglue(line)) || (days.length > 0 && DEAL_WORD_RE.test(quote));
    const underOneDay =
      !days.length && inContext && !ctx.dated && !ctx.hoursLike && (ctx.days.length === 1 || Boolean(ctx.dayHeading));
    deal._ctx = ctx;
    deal._basis = isPriceOnly(line) ? (underOneDay && ctx.dayHeading ? "heading" : "block") : namesDay ? "line" : underOneDay ? "heading" : "block";
    deal._labelled = inContext && BLOCK_LABEL_RE.test(ctx.label ?? "");
    // An undated promo outside any stated window runs every day until withdrawn.
    if ((limited || national) && !lineDays.length) {
      deal._basis = "promo";
      deal.kind = "limited_time";
      if (national) deal.conditions ??= NATIONAL_NOTE;
    }
    deals.push(deal);
    if (timeIsHappyHours) {
      const hh = makeDeal({ line: quote, title: "Happy Hour", days: lineDays, time, i });
      hh._basis = "announcement";
      hh._timeAdjacent = true;
      hh.price = null;
      deals.push(hh);
    }
    if (inContext) {
      ctx.block.push(deal);
      ctx.line = i;
    } else if (days.length) {
      openContext(i, { days, time, block: [deal] });
    }
  }

  const result = deals.filter((d) => {
    if (d.price !== null) return true;
    // A happy-hour announcement needs a time, and is redundant next to priced
    // happy-hour lines for the same days.
    if (!d.start_time && !d.end_time) return false;
    return !deals.some((o) => o.price !== null && o.title === d.title && o.days.join() === d.days.join());
  });
  // The same line repeated under several day headings is one deal on all of them.
  const merged = new Map();
  for (const d of result) {
    const key = `${d.title}|${d.quote}|${d.start_time}|${d.end_time}`;
    const first = merged.get(key);
    if (first) first.days = DAYS.filter((day) => first.days.includes(day) || d.days.includes(day));
    else merged.set(key, d);
  }
  const perHeading = new Map();
  for (const d of merged.values()) if (d._basis === "heading") perHeading.set(d._ctx, (perHeading.get(d._ctx) ?? 0) + 1);
  return [...merged.values()].slice(0, MAX_DEALS_PER_PAGE).map(({ _line, _basis, _timeAdjacent, _ctx, _labelled, ...d }) => {
    if (_basis === "heading" && perHeading.get(_ctx) > MAX_UNDER_ONE_HEADING) _basis = "block";
    const hasWindow = d.days.length > 0 && Boolean(d.start_time || d.end_time);
    // High confidence: the line names its own day, sits under a single weekday
    // heading, belongs to a labelled block (happy hour, late night, specials)
    // whose days and hours are both stated, or is a limited-time / chain promo.
    // Everything else (menu items under a heading, event listings) is kept in
    // the log but not published.
    const high =
      _basis === "line" ||
      _basis === "heading" ||
      _basis === "promo" ||
      (_basis === "block" && _labelled && hasWindow) ||
      (_basis === "announcement" && hasWindow && _timeAdjacent);
    return { ...d, confidence: high ? "high" : "low" };
  });
}

function makeDeal({ line, title, days, time, i }) {
  const text = tidy(line);
  return {
    title: clip(title ?? text, 70),
    description: clip(text, 220),
    price: line.match(OFFER_RE)?.[0].replace(/\s+/g, " ") ?? null,
    days,
    start_time: time?.start ?? null,
    end_time: time?.end ?? null,
    category: categoryOf(`${title ?? ""} ${line}`),
    kind: "recurring",
    valid_until: null,
    conditions: /dine[\s-]?in only/i.test(line) ? "Dine-in only" : null,
    platform: "in_house",
    quote: line,
    _line: i,
  };
}
