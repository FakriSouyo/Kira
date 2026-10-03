const TICKER = '[A-Z][A-Z0-9.-]{1,5}';
const PUNCTUATED_ACTION = '(?:[Bb][Uu][Yy]|[Ss][Ee][Ll][Ll]|[Hh][Oo][Ll][Dd]|[Ee][Nn][Tt][Ee][Rr]|[Ee][Xx][Ii][Tt])';

const ENGLISH_RECOMMENDATION = new RegExp(
  `\\b(?:` +
    `(?:you|we)\\s+(?:may want to|might want to|should|must|ought to|would|will)\\s+(?:not\\s+)?(?:buy|sell|hold|enter|exit)(?:ing)?\\b|` +
    `(?:you|we)\\s+(?:should|must|ought to|would|will)\\s+(?:increase|reduce)\\s+(?:your|our)\\s+position\\b|` +
    `i\\s+(?:should|must|ought to|would|will)\\s+(?:not\\s+)?(?:buy|sell|hold|enter|exit)(?:ing)?\\b|` +
    `i(?:'d|’d)\\s+(?:buy|sell|hold)(?:ing)?\\b|` +
    `(?:i|we|kira)\\s+(?:strongly\\s+)?recommend(?:s|ed)?(?:\\s+(?:that\\s+(?:you|we)|you|we))?\\s+(?:to\\s+)?(?:(?:buy|sell|hold|enter|exit)(?:ing)?|increas(?:e|ing)|reduc(?:e|ing))(?:\\s+(?:your|our)\\s+position)?\\b|` +
    `(?:our|my|kira(?:'s|’s))\\s+recommendation\\s+(?:is\\s+)?(?:to\\s+)?(?:buy|sell|hold|enter|exit)(?:ing)?\\b|` +
    `recommendation\\s*:\\s*(?:buy|sell|hold|enter|exit)(?:ing)?\\b|` +
    `my\\s+(?:recommendation|view|take)\\s+(?:is|would\\s+be)\\s+(?:to\\s+)?(?:a\\s+)?(?:strong\\s+)?(?:buy|sell|hold)(?:ing)?\\b|` +
    `(?:the\\s+)?(?:best|right)\\s+(?:action|move)\\s+is\\s+(?:to\\s+)?(?:buy|sell|hold)(?:ing)?\\b|` +
    `(?:do\\s+not|don't|never)\\s+(?:buy|sell|hold|enter|exit)(?:ing)?\\b|` +
    `keep\\s+holding(?:\\s+${TICKER})?\\b` +
  `)`,
  'i',
);
const ALLOCATION_ADVICE = `allocat(?:e|ing)\\s+\\d+(?:\\.\\d+)?%\\s+(?:(?:of\\s+(?:your|our)\\s+portfolio\\s+)?(?:in|into|to)\\s+${TICKER})`;
const POSITION_SIZE_ADVICE = `(?:set(?:ting)?\\s+(?:your\\s+|the\\s+)?position\\s+size\\s+(?:to|at|of)\\s+\\d+(?:\\.\\d+)?%?|use\\s+(?:a\\s+)?\\d+(?:\\.\\d+)?%\\s+position\\s+size)`;
const ORDER_ADVICE = `(?:(?:place|placing|submit|submitting|send|sending)\\s+(?:(?:a|the|your)\\s+)?(?:(?:limit|market|stop)\\s+)?orders?|(?:execute|executing)\\s+(?:(?:a|the|your)\\s+)?orders?)(?:\\s+(?:now|today|immediately|at\\s+\\$?\\d[\\d,.]*))?`;
const RISK_CONTROL_ADVICE = `(?:(?:set(?:ting)?|us(?:e|ing))\\s+(?:(?:a|the|your)\\s+)?stop[- ]loss(?:\\s+at\\s+\\$?\\d[\\d,.]*)?|tak(?:e|ing)\\s+profit(?:\\s+at\\s+\\$?\\d[\\d,.]*)?)`;
const ENGLISH_CONTEXTUAL_RECOMMENDATION = new RegExp(
  `(?:\\b(?:you|we)\\s+(?:may want to|might want to|should|must|ought to|would|will)\\s+(?:${ALLOCATION_ADVICE}|${POSITION_SIZE_ADVICE}|${ORDER_ADVICE}|${RISK_CONTROL_ADVICE})|` +
    `\\b(?:i|we|kira)\\s+(?:strongly\\s+)?recommend(?:s|ed)?\\s+(?:that\\s+(?:you|we)\\s+|(?:to\\s+)?)(?:${ALLOCATION_ADVICE}|${POSITION_SIZE_ADVICE}|${ORDER_ADVICE}|${RISK_CONTROL_ADVICE})|` +
    `\\b(?:my|our|kira(?:'s|’s))\\s+recommendation\\s+(?:is\\s+)?(?:to\\s+)?(?:${ALLOCATION_ADVICE}|${POSITION_SIZE_ADVICE}|${ORDER_ADVICE}|${RISK_CONTROL_ADVICE}))(?=$|\\s|[.!?;,])`,
  'i',
);
const CLAUSE_LEADING_CONSIDER = /(?:^|[.!?;]\s*)consider\s+(?:buying|selling|holding|buy|sell|hold)\b/i;
const CONTEXTUAL_RECOMMENDATION = /(?:^|[.!?;]\s*|,\s*)(?:based on (?:this|the) evidence|given (?:the )?valuation|if (?:the )?price falls),\s*(?:buy|sell|hold)\b/i;

const ENGLISH_DIRECT_IMPERATIVE = new RegExp(
  `(?:^|[.!?;]\\s*|,\\s*)${PUNCTUATED_ACTION}(?:\\s+(?:(?:now|today|immediately|for now|at\\s+\\$?\\d[\\d,.]*|below\\s+\\$?\\d[\\d,.]*|(?:(?:your|the|a|an|this)\\s+(?:shares?|stock|position|trade)|it))(?:\\s+(?:now|today|immediately))?))?(?=[.!?;,]|$)`,
  'i',
);
const ENGLISH_TICKER_IMPERATIVE = new RegExp(
  `(?:^|[.!?;]\\s*|,\\s*)${PUNCTUATED_ACTION}\\s+${TICKER}(?=\\s|[.!?;,]|$)`,
);
const ENGLISH_TARGETED_IMPERATIVE = new RegExp(
  `(?:^|[.!?;]\\s*|,\\s*)${PUNCTUATED_ACTION}\\s+(?:\\d+\\s+shares?\\s+(?:of\\s+)?${TICKER}|half\\s+(?:your|the)\\s+position|onto\\s+${TICKER})(?=\\s|[.!?;,]|$)`,
  'i',
);

const POSITION_INSTRUCTION = /(?:^|[.!?;]\s*)(?:increase|add(?:\s+to)?|reduce|cut|trim|scale\s+(?:up|down))\s+(?:your\s+|the\s+|a\s+|this\s+)?(?:position|holdings|exposure)\b|\b(?:set|use|choose)\s+(?:your\s+)?position\s+size\s+(?:to|at|of)\s+\d+(?:\.\d+)?%?\b/i;
const PORTFOLIO_TARGET = /\b(?:put|allocate|assign|dedicate|invest)\s+\d+(?:\.\d+)?%\s+(?:(?:of\s+)?(?:your\s+)?portfolio\s+)?(?:in|into|to)\s+[A-Z][A-Z0-9.-]{1,5}(?=\s|[.!?;,]|$)/i;
const POSITION_TARGET = /\btake\s+(?:a\s+)?\d+(?:\.\d+)?%\s+position\s+in\s+[A-Z][A-Z0-9.-]{1,5}(?=\s|[.!?;,]|$)/i;
const ORDER_INSTRUCTION = /(?:^|[.!?;]\s*|,\s*)(?:place|submit|execute|send)\s+(?:(?:a|the|your)\s+)?(?:(?:limit|market|stop)\s+)?orders?\b|(?:^|[.!?;]\s*|,\s*)execute\s+(?:the|your)\s+order(?:\s+(?:now|today|immediately))?\b|(?:^|[.!?;]\s*|,\s*)(?:set|place|use)\s+(?:(?:a|the|your)\s+)?(?:stop[- ]loss|take[- ]profit)\b|(?:^|[.!?;]\s*|,\s*)take[- ]profit\s+(?:at|to)\b/i;

const INDONESIAN_RECOMMENDATION = /(?:^|[.!?;]\s*)(?:(?:kira\s+merekomendasikan|kami\s+sarankan|rekomendasi\s+kira\s+adalah|(?:anda|kamu)\s+(?:sebaiknya|harus))\s*,?\s+(?:untuk\s+)?(?:beli|membeli|jual|menjual|tahan|menahan|masuk|keluar|tambah|kurangi)\b|(?:untuk sekarang|sebaiknya|mending|menurut saya|kalau saya|saya\s+(?:sarankan|merekomendasikan|akan)|lebih baik|jangan|tidak\s+usah|boleh|rekomendasi(?:\s+saya)?\s*(?::|adalah)?)\s*,?\s+(?:untuk\s+)?(?:beli|membeli|jual|menjual|tahan|menahan|masuk|keluar)\b|saya\s+(?:akan\s+)?(?:beli|membeli|jual|menjual|tahan|menahan))|(?:^|[.!?;]\s*)(?:anda|kamu)\s+sebaiknya\s+(?:keluar\s+dari\s+posisi|kurangi\s+posisi)\b/i;
const INDONESIAN_TICKER_CONCLUSION = new RegExp(
  `(?:^|[.!?;]\\s*)${TICKER}\\s+(?:layak|bagus|menarik)\\s+(?:untuk\\s+)?(?:di)?(?:beli|jual|tahan)\\b`,
);
const INDONESIAN_TICKER_IMPERATIVE = /(?:^|[.!?;]\s*)(?:beli|membeli|jual|menjual|tahan|menahan)\s+[A-Z][A-Z0-9.-]{1,5}(?=\s|[.!?;,]|$)/i;
const INDONESIAN_DIRECT_IMPERATIVE = /(?:^|[.!?;]\s*)(?:(?:jangan|tidak\s+usah)\s+)?(?:beli|membeli|jual|menjual|tahan|menahan|tambah(?:kan|lah)?|menambah|kurangi|mengurangi|masuk|keluar)\b(?:\s+(?:dulu|sekarang|segera|saham(?:\s+ini)?|posisi(?:\s+sekarang)?|dari\s+(?:saham|posisi)|di\s+\d[\d.]*))?(?:\s+(?:dulu|sekarang|segera|[A-Z][A-Z0-9.-]{1,5}|di\s+\d[\d.]*))?(?=[.!?;,]|$)|(?:^|[.!?;]\s*)(?:ambil|lepas)\s+posisi(?:\s+(?:di|pada)\s+[A-Z][A-Z0-9.-]{1,5})?\b/i;
const INDONESIAN_ORDER_INSTRUCTION = /(?:^|[.!?;]\s*)(?:pasang|setel)\s+(?:order\s+(?:beli|jual)(?:\s+[A-Z][A-Z0-9.-]{1,5})?|stop[- ]loss|take[- ]profit)\b(?:\s+(?:di|pada)\s+\d[\d.]*)?|(?:^|[.!?;]\s*)take[- ]profit\s+(?:di|pada)\s+\d[\d.]*/i;

const KIRA_TICKER_RATING = new RegExp(
  `\\b${TICKER}\\s+[Ii][Ss]\\s+(?:[Aa]\\s+)?(?:[Ss][Tt][Rr][Oo][Nn][Gg]\\s+)?(?:[Bb][Uu][Yy]|[Ss][Ee][Ll][Ll]|[Hh][Oo][Ll][Dd])(?![-\\w])\\b`,
);
const KIRA_GENERIC_RATING = /\b(?:this|it|the stock)\s+is\s+(?:a\s+)?(?:strong\s+)?(?:buy|sell|hold)(?![-\w])\b/i;
const ATTRIBUTED_RATING_SENTENCE = /^\s*(?:according to [^,.;!?]+,\s*|(?:(?:the\s+)?(?:broker|analyst|cited\s+(?:research\s+)?report|research\s+report|source)(?:\s+[A-Z][\w.-]*)?\s+(?:says|rates|labels|calls)\b|broker\s+[A-Z][\w.-]*\s+(?:says|rates|labels|calls)\b))/i;

function hasKiraRatingConclusion(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
    .some((sentence) => !ATTRIBUTED_RATING_SENTENCE.test(sentence)
      && (KIRA_TICKER_RATING.test(sentence) || KIRA_GENERIC_RATING.test(sentence)));
}

/** True only for clear English or Indonesian advice selecting a user financial transaction. */
export function hasTransactionDirective(text: string): boolean {
  return ENGLISH_RECOMMENDATION.test(text)
    || ENGLISH_CONTEXTUAL_RECOMMENDATION.test(text)
    || CLAUSE_LEADING_CONSIDER.test(text)
    || CONTEXTUAL_RECOMMENDATION.test(text)
    || ENGLISH_DIRECT_IMPERATIVE.test(text)
    || ENGLISH_TICKER_IMPERATIVE.test(text)
    || ENGLISH_TARGETED_IMPERATIVE.test(text)
    || POSITION_INSTRUCTION.test(text)
    || PORTFOLIO_TARGET.test(text)
    || POSITION_TARGET.test(text)
    || ORDER_INSTRUCTION.test(text)
    || INDONESIAN_RECOMMENDATION.test(text)
    || INDONESIAN_TICKER_CONCLUSION.test(text)
    || INDONESIAN_TICKER_IMPERATIVE.test(text)
    || INDONESIAN_DIRECT_IMPERATIVE.test(text)
    || INDONESIAN_ORDER_INSTRUCTION.test(text)
    || hasKiraRatingConclusion(text);
}
