// ─── LORE MAP + TICKER MORPHOLOGY ENGINE ────────────────────────

// ─── Morphology Pattern Generator ───────────────────────────────
export const generateTickerVariants = (symbol) => {
  const s = symbol.toUpperCase()

  const variants = new Set()

  // Prefix patterns — English + Japanese + Spanish + Korean
  const prefixes = [
    // English
    'BABY', 'MINI', 'MIKO', 'MICRO', 'GIGA', 'MEGA', 'SUPER',
    'BASED', 'REAL', 'OG', 'THE', 'RETRO', 'TURBO', 'CHAD', 'DEGEN', 'FAT', 'TINY',
    // Japanese
    'NEKO', 'SHIRO', 'KURO', 'HANA', 'YUKI',
    // Spanish
    'EL', 'LA', 'LOS', 'DEL',
  ]
  prefixes.forEach(p => variants.add(`${p}${s}`))

  // Suffix patterns — English + Japanese + Korean + Spanish
  const suffixes = [
    // English
    'INU', 'WIF', 'HAT', 'CAT', 'DOG', 'AI', 'GPT',
    'DAO', 'FI', 'X', '2', '3', 'PLUS', 'PRO', 'MOON', 'PUMP',
    // Feminine / diminutive variants — catches GROKETTE, TRUMPETTE etc
    'ETTE', 'ELLA', 'GIRL', 'LADY', 'QUEEN', 'WIFE',
    // Dark/evil variants
    'EVIL', 'DARK', 'BAD', 'MEAN', 'CURSED',
    // Size variants
    'BIG', 'TINY', 'GIGA', 'MEGA',
    // Japanese honorifics
    'SAN', 'KUN', 'CHAN', 'SAMA', 'SENSEI',
    // Korean
    'OPPA', 'UNNIE',
    // Spanish diminutives
    'ITO', 'ITA', 'ILLO',
  ]
  suffixes.forEach(sfx => variants.add(`${s}${sfx}`))

  // Compound patterns
  variants.add(`${s}WIF`)
  variants.add(`WIF${s}`)
  variants.add(`${s}CAT`)
  variants.add(`CAT${s}`)
  variants.add(`${s}DOG`)
  variants.add(`DOG${s}`)

  // Opposite / mirror patterns
  const opposites = {
    BULL: ['BEAR'], BEAR: ['BULL'],
    MOON: ['DOOM', 'RUG'], LONG: ['SHORT'],
    UP: ['DOWN'], PUMP: ['DUMP'],
    RICH: ['POOR'], CHAD: ['VIRGIN', 'BETA'],
    DAY: ['NIGHT'], SUN: ['MOON'],
    HOT: ['COLD'], FAST: ['SLOW'],
    BIG: ['SMALL', 'TINY'], GOOD: ['EVIL', 'BAD'],
    LIGHT: ['DARK'],
    TRUMP: ['BIDEN', 'KAMALA', 'BODEN'],
    BIDEN: ['TRUMP'], PEPE: ['WOJAK'], WOJAK: ['PEPE'],
  }
  if (opposites[s]) opposites[s].forEach(o => variants.add(o))

  // Companion / universe patterns
  const companions = {
    TRUMP: ['MELANIA', 'BARRON', 'IVANKA', 'MAGA', 'BARON'],
    MELANIA: ['TRUMP', 'BARRON'],
    BONNIE: ['CLYDE'], CLYDE: ['BONNIE'],
    TOM: ['JERRY'], JERRY: ['TOM'],
    BATMAN: ['ROBIN', 'JOKER', 'GOTHAM'],
    JOKER: ['BATMAN', 'HARLEY'],
    WIF: ['HAT', 'CATWIF', 'WIFCAT', 'BABYWIF'],
    HAT: ['WIF', 'DOGHAT'],
    BONK: ['BABYBONK', 'BONKWIF', 'MEGABONK'],
    PEPE: ['RARE', 'FEELSGOOD', 'PEPEWIF', 'PEEPO'],
    DOGE: ['SHIB', 'FLOKI', 'BABYDOGE'],
    SHIB: ['DOGE', 'LEASH', 'BONE'],
    SOL: ['BONK', 'WIF', 'POPCAT'],
    AI: ['AGI', 'GPT', 'NEURAL', 'ROBOT', 'AGENT'],
    ELON: ['MUSK', 'TESLA', 'SPACEX', 'MARS', 'X'],
    MUSK: ['ELON', 'TESLA', 'DOGE'],
    POPCAT: ['POPDOG', 'POPELON', 'POPWIF'],
    MYRO: ['BABYMYRO', 'MYROCAT', 'MYROWIF'],
    MARIO: ['LUIGI', 'PEACH', 'WARIO', 'BOWSER', 'TOAD'],
    LUIGI: ['MARIO', 'PEACH', 'WARIO'],
    SONIC: ['TAILS', 'KNUCKLES', 'SHADOW', 'AMY'],
    WALTER: ['JESSE', 'HEISENBERG', 'SKYLER'],
    JESSE: ['WALTER', 'HEISENBERG', 'PINKMAN'],
  }
  if (companions[s]) companions[s].forEach(c => variants.add(c))

  // Size variants
  variants.add(`BABY${s}`)
  variants.add(`GIGA${s}`)
  variants.add(`MINI${s}`)
  variants.add(`MEGA${s}`)
  variants.add(`FAT${s}`)
  variants.add(`TINY${s}`)

  // Remove the alpha itself
  variants.delete(s)

  return Array.from(variants)
}

// ─── LORE MAP ────────────────────────────────────────────────────
const LORE_MAP = {
  // ── Dog / Hat narrative ──
  WIF:    { terms: ['catwif','babywif','wifhat','hat','dogwif','wif'], concepts: ['dog','hat','wif','dogwifhat'], category: 'dogs', universe: 'dogwifhat' },
  BONK:   { terms: ['babybonk','bonkwif','megabonk','bonk'], concepts: ['bonk','dog','solana'], category: 'dogs', universe: 'solana-dogs' },
  MYRO:   { terms: ['babymyro','myrowif','myro'], concepts: ['myro','dog','solana'], category: 'dogs', universe: 'solana-dogs' },
  DOGE:   { terms: ['babydoge','dogecoin','doge','shib','elon','floki'], concepts: ['doge','dog','elon'], category: 'dogs', universe: 'doge-ecosystem' },
  // Dog slang — all map to the same dog universe
  DAWG:   { terms: ['dog','doge','shiba','puppy','hound','canine','mutt','doggo','woof','dogwif','bonk','myro'], concepts: ['dog','slang','dawg'], category: 'dogs', universe: 'solana-dogs' },
  DOG:    { terms: ['dawg','doge','shiba','puppy','hound','canine','mutt','doggo','woof','bonk','inu'], concepts: ['dog','dawg'], category: 'dogs', universe: 'solana-dogs' },
  DOGGY:  { terms: ['dog','dawg','doge','puppy','shiba','woof','mutt','canine'], concepts: ['dog','doggy','slang'], category: 'dogs', universe: 'solana-dogs' },
  DOGG:   { terms: ['dog','dawg','doge','shiba','puppy','hound','canine'], concepts: ['dog','slang'], category: 'dogs', universe: 'solana-dogs' },
  PUPPER: { terms: ['puppy','pup','dog','dawg','doggo','shiba','canine'], concepts: ['dog','puppy','slang'], category: 'dogs', universe: 'solana-dogs' },
  PUP:    { terms: ['puppy','pupper','dog','dawg','doggo','shiba'], concepts: ['dog','puppy'], category: 'dogs', universe: 'solana-dogs' },

  // ── Cat narrative ──
  POPCAT: { terms: ['popdog','popelon','pop','cat'], concepts: ['cat','pop','meme'], category: 'cats', universe: 'pop-memes' },
  MEW:    { terms: ['babymew','mewwif','mew','cat'], concepts: ['cat','mew','solana'], category: 'cats', universe: 'solana-cats' },

  // ── Frog narrative ──
  PEPE:   { terms: ['pepe','frog','pepewif','peepo','kermit','pepesolana'], concepts: ['pepe','frog','kek'], category: 'frogs', universe: 'pepe' },

  // ── Political narrative ──
  TRUMP:   { terms: ['maga','america','usa','biden','melania','barron','ivanka','donald','trumpy'], concepts: ['trump','maga','political','usa'], category: 'political', universe: 'trump-family' },
  BODEN:   { terms: ['biden','joe','hunter','kamala','boden','obama','obema','barry'], concepts: ['political','biden','usa'], category: 'political', universe: 'us-politics' },
  MELANIA: { terms: ['trump','barron','melania'], concepts: ['trump','political','usa'], category: 'political', universe: 'trump-family' },

  // ── AI / Tech narrative ──
  AI16Z:  { terms: ['ai','agent','eliza','degenai','vc','a16z'], concepts: ['ai','agent','tech'], category: 'ai', universe: 'ai-agents' },
  GOAT:   { terms: ['goat','ai','terminal','truth'], concepts: ['ai','goat','terminal'], category: 'ai', universe: 'ai-terminal' },
  CLAUDE: { terms: ['claude','anthropic','ai','llm','sonnet'], concepts: ['ai','claude','anthropic'], category: 'ai', universe: 'ai-models' },
  GPT:    { terms: ['gpt','openai','chatgpt','ai','llm'], concepts: ['ai','gpt','openai'], category: 'ai', universe: 'ai-models' },
  GEMMA:  { terms: ['gemma','google','ai','llm','gemini','model','deepmind'], concepts: ['ai','gemma','google'], category: 'ai', universe: 'ai-models' },
  GEMMA4: { terms: ['gemma','gemma4','google','ai','llm','gemini','model'], concepts: ['ai','gemma4','google'], category: 'ai', universe: 'ai-models' },
  VIBE:   { terms: ['vibecode','vibecoding','cursor','devin','coder'], concepts: ['vibe','coding','ai','dev'], category: 'ai', universe: 'vibecoding' },

  // ── Gaming narrative ──
  MARIO:  { terms: ['mario','luigi','peach','wario','bowser','nintendo'], concepts: ['mario','gaming','nintendo'], category: 'gaming', universe: 'mario' },
  LUIGI:  { terms: ['mario','luigi','peach','wario'], concepts: ['luigi','gaming','nintendo'], category: 'gaming', universe: 'mario' },
  SONIC:  { terms: ['sonic','tails','knuckles','shadow','sega'], concepts: ['sonic','gaming','sega'], category: 'gaming', universe: 'sonic' },
  PIKACHU:{ terms: ['pikachu','pokemon','charizard','bulbasaur'], concepts: ['pokemon','gaming','nintendo'], category: 'gaming', universe: 'pokemon' },

  // ── Movies / TV narrative ──
  WALTER: { terms: ['walter','jesse','heisenberg','skyler','breakingbad','bb'], concepts: ['breakingbad','chemistry','tv'], category: 'tv', universe: 'breaking-bad' },
  JESSE:  { terms: ['jesse','walter','heisenberg','pinkman'], concepts: ['breakingbad','chemistry','tv'], category: 'tv', universe: 'breaking-bad' },
  JOKER:  { terms: ['joker','batman','harley','gotham','dc'], concepts: ['joker','comic','dc'], category: 'movies', universe: 'dc' },
  BATMAN: { terms: ['batman','robin','joker','gotham'], concepts: ['batman','comic','dc'], category: 'movies', universe: 'dc' },

  // ── Elon / Space narrative ──
  ELON:   { terms: ['doge','spacex','mars','tesla','musk','x'], concepts: ['elon','space','doge'], category: 'elon', universe: 'elon-musk' },
  MUSK:   { terms: ['elon','tesla','spacex','doge','x'], concepts: ['elon','space'], category: 'elon', universe: 'elon-musk' },

  // ── Peanut / Viral animals ──
  PNUT:   { terms: ['peanut','squirrel','nut','pnut'], concepts: ['peanut','squirrel','viral'], category: 'animals', universe: 'viral-animals' },

  // ── Anime / Waifu ──
  ANIME:  { terms: ['anime','waifu','otaku','manga','kawaii'], concepts: ['anime','waifu','japan'], category: 'anime', universe: 'anime' },
  CHIBI:  { terms: ['chibi','kawaii','mini','tiny','cute','sd','superdeformed','chibified','chibiverse','chibi elon','chibielon','chibi pepe','chibipepe','chibi doge','chibidoge'], concepts: ['chibi','kawaii','anime','cute'], category: 'anime', universe: 'chibi' },

  // ── Food narrative ──
  BURGER: { terms: ['burger','mcdonalds','bigmac','fries','wendys'], concepts: ['burger','food','fast-food'], category: 'food', universe: 'fast-food' },
  PIZZA:  { terms: ['pizza','pepperoni','dominos','slice'], concepts: ['pizza','food'], category: 'food', universe: 'food' },
  RAMEN:  { terms: ['ramen','noodle','soup'], concepts: ['ramen','food','japan'], category: 'food', universe: 'food' },

  // ── Sports narrative ──
  RONALDO:{ terms: ['ronaldo','messi','soccer','football','cr7','siuuu'], concepts: ['ronaldo','soccer','sports'], category: 'sports', universe: 'soccer' },
  MESSI:  { terms: ['messi','ronaldo','soccer','football'], concepts: ['messi','soccer','sports'], category: 'sports', universe: 'soccer' },

  // ── Meme formats ──
  WOJAK:  { terms: ['wojak','pepe','chad','npc','meme'], concepts: ['wojak','meme','feels'], category: 'memes', universe: 'wojak' },
  CHAD:   { terms: ['chad','virgin','gigachad','sigma'], concepts: ['chad','meme','sigma'], category: 'memes', universe: 'chad' },
  NPC:    { terms: ['npc','wojak','normie'], concepts: ['npc','meme','social'], category: 'memes', universe: 'wojak' },

  // ── Toilet humor / gas / fart narrative ─────────────────────────
  // Massive degen category — any gas/fart/poop token triggers this universe
  FART:      { terms: ['fart','poop','burp','stink','flatulence','toot','methane','gas','toilet','skunk'], concepts: ['fart','gas','humor','toilet'], category: 'humor', universe: 'toilet-humor' },
  POOP:      { terms: ['poop','fart','burp','stink','toilet','shit','crap','dung','turd','brown'], concepts: ['poop','fart','humor','toilet'], category: 'humor', universe: 'toilet-humor' },
  METHANE:   { terms: ['fart','cow','poop','burp','stink','beef','barn','flatulence','gas'], concepts: ['methane','fart','cow','gas'], category: 'humor', universe: 'toilet-humor' },
  GAS:       { terms: ['fart','fuel','petrol','gwei','fee','stink','nitro'], concepts: ['gas','fart','fuel','crypto'], category: 'humor', universe: 'gas-narrative' },
  STINK:     { terms: ['stink','fart','smell','skunk','odor','poop','burp','rotten'], concepts: ['stink','fart','smell'], category: 'humor', universe: 'toilet-humor' },

  // ── Farm / livestock narrative ────────────────────────────────────
  COW:       { terms: ['cow','bull','beef','dairy','milk','barn','farm','cattle','bovine','moo','steak','udder','calf'], concepts: ['cow','farm','animal'], category: 'animals', universe: 'farm' },
  BULL:      { terms: ['bull','cow','beef','steak','horns','cattle','matador','bear','bison'], concepts: ['bull','farm','animal','finance'], category: 'animals', universe: 'farm' },
  FARM:      { terms: ['farm','barn','cow','pig','horse','goat','rooster','tractor'], concepts: ['farm','animal','rural'], category: 'animals', universe: 'farm' },
  PIG:       { terms: ['pig','pork','bacon','oink','ham','piggy','boar','swine','farm'], concepts: ['pig','farm','animal'], category: 'animals', universe: 'farm' },

  // ── Internet humor / emotion ─────────────────────────────────────
  LOL:    { terms: ['lol','lmao','rofl','haha','funny','laugh','giggle','kek','humor','joke','meme','lulz'], concepts: ['lol','laugh','humor','funny','internet'], category: 'humor', universe: 'internet-humor' },
  LMAO:   { terms: ['lmao','lol','rofl','laugh','haha','kek','funny'], concepts: ['lmao','laugh','humor'], category: 'humor', universe: 'internet-humor' },
  HAHA:   { terms: ['haha','lol','lmao','laugh','giggle','funny'], concepts: ['haha','laugh','humor'], category: 'humor', universe: 'internet-humor' },
  COPE:   { terms: ['cope','seethe','mald','cringe','ratio','skill','issue'], concepts: ['cope','internet','slang'], category: 'memes', universe: 'internet-slang' },
  SEETHE: { terms: ['seethe','cope','mald','cringe','rent','free'], concepts: ['seethe','cope','internet'], category: 'memes', universe: 'internet-slang' },
  GG:     { terms: ['gg','wp','ez','noob','rekt','frag','gg2ez'], concepts: ['gg','gaming','internet'], category: 'gaming', universe: 'gaming-slang' },
  WAGMI:  { terms: ['wagmi','ngmi','gm','gn','wen'], concepts: ['wagmi','crypto','slang'], category: 'crypto', universe: 'crypto-slang' },
  NGMI:   { terms: ['ngmi','wagmi','rekt','rug','dump'], concepts: ['ngmi','crypto','slang'], category: 'crypto', universe: 'crypto-slang' },

  // ── Chinese cultural narrative ───────────────────────────────────
  // 摸鱼 (Moyu) = Chinese internet slang for "slacking off at work" — massive meme
  MOYU:    { terms: ['摸鱼','moyu','躺平','打工','社畜','fish','slack'], concepts: ['摸鱼','moyu','china','slang','viral'], category: 'chinese', universe: 'china-slang' },
  '摸鱼':  { terms: ['摸鱼','moyu','躺平','鱼','fish'], concepts: ['摸鱼','moyu','china'], category: 'chinese', universe: 'china-slang' },
  // 哈基米 — viral Chinese cat meme
  HAJIMI:  { terms: ['哈基米','hajimi','hachimi','cat','猫'], concepts: ['哈基米','cat','china','viral'], category: 'chinese', universe: 'china-memes' },
  // Chinese viral figures
  '刘元立': { terms: ['刘元立','liu','yuanli','china'], concepts: ['刘元立','china','viral'], category: 'chinese', universe: 'china-memes' },
  '索姥姥': { terms: ['索姥姥','grandma','china','granny'], concepts: ['索姥姥','china','viral'], category: 'chinese', universe: 'china-memes' },
  // Chinese zodiac / animals
  DRAGON:  { terms: ['dragon','龙','loong','fire'], concepts: ['dragon','china','zodiac'], category: 'chinese', universe: 'chinese-zodiac' },
  TIGER:   { terms: ['tiger','虎','tigercoin','bengal'], concepts: ['tiger','china','zodiac'], category: 'chinese', universe: 'chinese-zodiac' },
  PANDA:   { terms: ['panda','熊猫','bamboo','china','bear'], concepts: ['panda','china','animal'], category: 'chinese', universe: 'china-animals' },
  // Chinese internet slang
  YYDS:    { terms: ['yyds','永远滴神','goat','china','legend'], concepts: ['yyds','china','slang'], category: 'chinese', universe: 'china-slang' },

  // ── Japanese cultural narrative ──────────────────────────────────
  NEKO:    { terms: ['neko','cat','nekocoin','kawaii','japan','にゃん'], concepts: ['neko','cat','japan'], category: 'japanese', universe: 'japan-memes' },
  SHIBA:   { terms: ['shiba','inu','doge','shib','japan','dog','柴犬'], concepts: ['shiba','dog','japan'], category: 'japanese', universe: 'japan-dogs' },
  SAKURA:  { terms: ['sakura','cherry','blossom','japan','spring','桜'], concepts: ['sakura','japan','flower'], category: 'japanese', universe: 'japan-culture' },
  KAITO:   { terms: ['kaito','kai','vocaloid','hatsune','miku','japan'], concepts: ['kaito','vocaloid','japan'], category: 'japanese', universe: 'vocaloid' },
  MIKU:    { terms: ['miku','hatsune','vocaloid','anime','japan','初音'], concepts: ['miku','vocaloid','anime'], category: 'japanese', universe: 'vocaloid' },
  NARUTO:  { terms: ['naruto','sasuke','ninja','hokage','konoha','boruto'], concepts: ['naruto','anime','ninja'], category: 'anime', universe: 'naruto' },
  GOKU:    { terms: ['goku','vegeta','saiyan','dragonball','dbz','kamehameha'], concepts: ['goku','dragonball','anime'], category: 'anime', universe: 'dragonball' },

  // ── Korean cultural narrative ────────────────────────────────────
  BTS:     { terms: ['bts','kpop','bangtan','jimin','jungkook','rm','suga','army'], concepts: ['bts','kpop','korea'], category: 'korean', universe: 'kpop' },
  KPOP:    { terms: ['kpop','blackpink','twice','aespa','ive','korea','idol'], concepts: ['kpop','korea','idol'], category: 'korean', universe: 'kpop' },
  KIMCHI:  { terms: ['kimchi','korea','seoul','kfood','bibimbap'], concepts: ['kimchi','korea','food'], category: 'korean', universe: 'korea-culture' },

  // ── Spanish / Latin American narrative ──────────────────────────
  PAPI:    { terms: ['papi','mami','latin','español','loco','chico'], concepts: ['papi','latin','spanish'], category: 'spanish', universe: 'latin-memes' },

  // ── Expanded anime ───────────────────────────────────────────────
  LUFFY:   { terms: ['luffy','onepiece','zoro','nami','pirate','nakama'], concepts: ['luffy','onepiece','anime'], category: 'anime', universe: 'onepiece' },

  // ── Disease / Virus / Threat narrative ───────────────────────────
  // When a disease/threat token pumps, degens immediately spin up tokens for:
  // the carrier animal, the pharma response, the symptoms, the antagonists.
  // These lore entries surface those derivative tokens correctly.
  HANTA:    { terms: ['rat','mouse','rodent','deermouse','virus','hantavirus','fever','lung','outbreak','vaccine','pfizer','cdc','who','hazmat','biohazard','ratwif','ratcat','viruswif','mask'], concepts: ['hanta','virus','rodent','disease'], category: 'horror', universe: 'disease-narrative' },
  VIRUS:    { terms: ['covid','plague','outbreak','pandemic','infected','pathogen','bacteria','germ','disease','hanta','ebola','flu','contagion','vaccine','pfizer','moderna','cdc'], concepts: ['virus','disease','outbreak'], category: 'horror', universe: 'disease-narrative' },
  PLAGUE:   { terms: ['blackdeath','rat','flea','medieval','death','skull','pandemic','epidemic','infected','pox','cholera','pestilence','biohazard'], concepts: ['plague','death','disease'], category: 'horror', universe: 'disease-narrative' },
  EBOLA:    { terms: ['virus','outbreak','africa','fever','hemorrhagic','infected','quarantine','biohazard','hazmat','cdc','who','vaccine'], concepts: ['ebola','virus','disease'], category: 'horror', universe: 'disease-narrative' },
  COVID:    { terms: ['corona','pandemic','vaccine','pfizer','moderna','astrazeneca','mrna','lockdown','mask','variant','delta','omicron','bat','wuhan','cdc','who'], concepts: ['covid','corona','pandemic'], category: 'horror', universe: 'disease-narrative' },
  ZOMBIE:   { terms: ['undead','walker','dead','brain','apocalypse','infected','horde','shambler','ghoul','necro','rotten','corpse'], concepts: ['zombie','undead','horror'], category: 'horror', universe: 'zombie-apocalypse' },
  SKULL:    { terms: ['bones','death','dead','grim','reaper','crossbones','skeleton','undead','zombie','pirate','cursed'], concepts: ['skull','death','horror'], category: 'horror', universe: 'dark-narrative' },
  // Pharma / vaccine tokens that spawn from disease narratives
  PFIZER:   { terms: ['vaccine','mrna','moderna','astrazeneca','jab','shot','pharma','drug','antiviral','covid','hanta','virus','cdc','who','fauci'], concepts: ['pfizer','vaccine','pharma'], category: 'pharma', universe: 'disease-narrative' },
  VACCINE:  { terms: ['pfizer','moderna','jab','shot','mrna','antiviral','pharma','immunity','booster','cdc','fauci','mandate'], concepts: ['vaccine','pharma','jab'], category: 'pharma', universe: 'disease-narrative' },
}

// ─── Narrative Categories (Vector 16) ───────────────────────────
// Used for meta narrative detection — what's the dominant theme right now?
// ─── Narrative Categories ─────────────────────────────────────────
// ORDERING MATTERS: specific categories first, generic last.
// detectCategory() returns on first match — so 'dogs' must come
// before 'animals', 'frogs' before 'animals', etc.
// priority: 1 = most specific (checked first), 3 = generic fallback.

export const NARRATIVE_CATEGORIES = {
  // ── Tier 1: Highly specific — unique keywords, low overlap ──────
  aliens:    { label: '👽 Aliens',    priority: 1, keywords: ['alien','ufo','disclosure','area51','extraterrestrial','greys','abduct','roswell','saucer'] },
  horror:    { label: '☠️ Horror',    priority: 1, keywords: ['zombie','skull','dead','undead','ghost','horror','cursed','demon','dark','evil','plague','virus','hanta','ebola','infected','outbreak'] },
  pharma:    { label: '💊 Pharma',    priority: 1, keywords: ['vaccine','pfizer','moderna','mrna','pharma','drug','antiviral','jab','shot','cdc','fauci','astrazeneca'] },
  frogs:     { label: '🐸 Frog',     priority: 1, keywords: ['pepe','frog','toad','feels','kek','peepo','ribbit','kermit'] },
  dogs:      { label: '🐕 Dog',      priority: 1, keywords: ['wif','bonk','shib','doge','inu','pup','mutt','puppy','doggo','woofie','dawg','dog','doggy','dogg','pupper','hound','canine','woof','shiba'] },
  cats:      { label: '🐱 Cat',      priority: 1, keywords: ['cat','mew','nyan','kitty','meow','kitten','purr','whisker'] },
  elon:      { label: '⚡ Elon',      priority: 1, keywords: ['elon','musk','spacex','grok','neuralink','xaei'] },
  trump:     { label: '🇺🇸 Trump',    priority: 1, keywords: ['trump','maga','melania','barron','ivanka','donnie','magahat'] },
  pippin:    { label: '🧙 Fantasy',   priority: 1, keywords: ['pippin','frodo','gandalf','hobbit','lotr','tolkien','shire','sauron','gollum','mordor'] },
  anime:     { label: '⛩️ Anime',     priority: 1, keywords: ['anime','waifu','manga','otaku','kawaii','naruto','goku','dragonball','onepiece','bleach','chainsaw'] },
  gaming:    { label: '🎮 Gaming',    keywords: ['mario','sonic','pokemon','pikachu','luigi','zelda','minecraft','fortnite','roblox','xbox','nintendo','playstation'] },
  bears:     { label: '🐻 Bears',     priority: 1, keywords: ['bear','panda','grizzly','polar','teddy','koala','honey'] },
  nature:    { label: '🌿 Nature',    priority: 1, keywords: ['tree','grass','leaf','flower','forest','jungle','vine','herb','plant','bamboo','moss','fern','oak','pine'] },
  penguins:  { label: '🐧 Penguins',  priority: 1, keywords: ['penguin','waddle','tux','arctic','igloo','pingu'] },

  // ── Tier 2: Moderate specificity ────────────────────────────────
  ai:        { label: '🤖 AI',        priority: 2, keywords: ['ai','gpt','neural','agent','llm','robot','claude','vibe','cursor','devin','copilot','gemini','chatbot','gemma','deepmind','anthropic','mistral','groq','llama'] },
  political: { label: '🏛️ Political', priority: 1, keywords: ['trump','maga','donald','melania','biden','obama','kamala','barron','ivanka','republican','democrat','president','election','vote','senate','congress','usa','murt','obema','dunald','drump','bidun','trumpy','obonga','barrack','potus','whitehouse'] },
  space:     { label: '🚀 Space',     priority: 2, keywords: ['moon','mars','space','rocket','nasa','galaxy','star','cosmos','astronaut','orbit','saturn','jupiter'] },
  movies:    { label: '🎬 Movies/TV', priority: 2, keywords: ['walter','jesse','joker','batman','breaking','heisenberg','marvel','dc','disney','netflix','hbo','squid'] },
  celebrity: { label: '⭐ Celebrity', priority: 2, keywords: ['kanye','taylor','swift','drake','rihanna','beyonce','mrbeast','pewdiepie','hawk','tuah','diddy','jay','snoop'] },
  sports:    { label: '⚽ Sports',    priority: 2, keywords: ['ronaldo','messi','soccer','football','nba','nfl','nhl','sport','goat','champion','lebron','curry'] },
  food:      { label: '🍔 Food',      priority: 2, keywords: ['burger','pizza','ramen','taco','sushi','noodle','food','eat','cook','chef','hungry','kebab','curry'] },
  crypto:    { label: '₿ Crypto',    priority: 2, keywords: ['bitcoin','btc','satoshi','nakamoto','hodl','blockchain','defi'] },
  memes:     { label: '😂 Memes',     priority: 2, keywords: ['wojak','chad','npc','sigma','based','gigachad','virgin','normie','doomer','zoomer','boomer','ratio'] },
  humor:     { label: '😂 Humor',     priority: 2, keywords: ['lol','lmao','rofl','haha','kek','lulz','funny','laugh','giggle','joke','humor','comedy','hilarious','fart','poop','burp','stink','toot','toilet','prank'] },
  internet_culture: { label: '🌐 Internet', priority: 1, keywords: ['lol','lmao','rofl','gg','wagmi','ngmi','gm','gn','cope','seethe','rekt','fud','ser','fren','anon','degen','wen','probably nothing','this is fine','touch grass','hfsp'] },

  // ── Tier 3: Generic — only match if nothing else does ───────────
  animals:   { label: '🦎 Animals',   priority: 3, keywords: ['bird','fish','bull','ape','monkey','snake','wolf','fox','lion','tiger','rhino','hippo','croc','hamster','rabbit'] },
  holiday:   { label: '🎄 Seasonal',  priority: 3, keywords: ['christmas','halloween','easter','thanksgiving','xmas','santa','pumpkin','turkey','firework','valentine'] },

  // ── Language / Cultural narratives ──────────────────────────────
  chinese:   {
    label: '🇨🇳 Chinese', priority: 1,
    keywords: [
      'china','chinese','beijing','shanghai','moyu','yyds','hajimi','hachimi','panda','dragon',
      '摸鱼','躺平','打工','社畜','内卷','绝绝子','永远滴神',
      '中','文','刘','元','立','索','姥','哈','基','米','龙','虎','猫','熊','鱼',
      '狗','牛','鼠','兔','蛇','马','羊','猴','鸡','猪','神','华','国','民',
    ],
  },
  japanese:  {
    label: '🇯🇵 Japanese', priority: 1,
    keywords: [
      'japan','japanese','tokyo','osaka','neko','shiba','sakura','miku','kawaii',
      'desu','chan','kun','san','sama','oshi','otaku','vocaloid',
      'の','日','本','東','京','猫','犬','桜','初','音','未','来','神','侍','忍',
    ],
  },
  korean:    {
    label: '🇰🇷 Korean', priority: 1,
    keywords: [
      'korea','korean','seoul','kpop','bts','blackpink','kimchi','oppa','daebak',
      '한','국','서','울','케','이','팝','비','티','에','스',
    ],
  },
  spanish:   {
    label: '🌮 Latino', priority: 2,
    keywords: [
      'papi','mami','latin','latino','español','mexico','taco','loco','chico',
      'chica','amigo','dios','mio','peso','brazil','samba','carnival',
    ],
  },
}

// ─── Category Trait System ────────────────────────────────────────
// Each category gets a set of abstract trait tags.
// MetaSeed compatibility is determined by trait overlap — no hardcoded pairs.
// Add new categories here with traits; compatibility logic self-maintains.
//
// Trait vocabulary:
//   fictional    — token universe is invented/narrative (anime, gaming, movies)
//   character    — token represents a named character or persona
//   real_world   — token references real people, places, or events
//   creature     — token represents an animal or living being
//   meme         — token is fundamentally a meme/joke format
//   culture      — token references a cultural movement or shared identity
//   internet     — token lives primarily in online/CT space
//   tech         — token references technology, AI, or science
//   nature       — token references the natural world
//   emotion      — token represents a feeling or reaction
//   political    — token references governance, elections, or ideology
//   japanese     — token is rooted in Japanese language or culture
//   chinese      — token is rooted in Chinese language or culture
//   korean       — token is rooted in Korean language or culture
//   latin        — token is rooted in Latin/Spanish language or culture
export const CATEGORY_TRAITS = {
  aliens:           ['fictional', 'creature', 'sci_fi', 'meme'],
  horror:           ['culture', 'meme', 'real_world', 'creature'],
  pharma:           ['real_world', 'tech', 'political'],
  frogs:            ['creature', 'meme', 'nature', 'internet', 'culture'],
  dogs:             ['creature', 'meme', 'nature', 'culture'],
  cats:             ['creature', 'meme', 'nature', 'culture'],
  bears:            ['creature', 'nature', 'meme'],
  penguins:         ['creature', 'nature', 'meme'],
  animals:          ['creature', 'nature', 'meme'],
  nature:           ['nature', 'creature'],
  elon:             ['real_world', 'character', 'tech', 'political', 'meme', 'internet', 'culture', 'sci_fi'],
  trump:            ['real_world', 'character', 'political', 'meme', 'culture'],
  political:        ['real_world', 'political', 'meme', 'culture'],
  celebrity:        ['real_world', 'character', 'culture', 'meme'],
  ai:               ['tech', 'sci_fi', 'culture', 'internet', 'fictional'],
  space:            ['sci_fi', 'tech', 'fictional', 'nature', 'culture'],
  anime:            ['fictional', 'character', 'japanese', 'culture'],
  gaming:           ['fictional', 'character', 'culture', 'internet'],
  movies:           ['fictional', 'character', 'culture', 'meme'],
  sports:           ['real_world', 'character', 'culture'],
  food:             ['culture', 'meme', 'nature'],
  memes:            ['meme', 'internet', 'culture', 'emotion'],
  humor:            ['meme', 'internet', 'emotion', 'culture'],
  internet_culture: ['meme', 'internet', 'culture', 'emotion'],
  crypto:           ['tech', 'internet', 'culture'],
  pippin:           ['fictional', 'character', 'culture'],
  holiday:          ['culture', 'meme', 'real_world'],
  japanese:         ['japanese', 'culture', 'character'],
  chinese:          ['chinese', 'culture', 'character'],
  korean:           ['korean', 'culture', 'character'],
  spanish:          ['latin', 'culture', 'character'],
}

// Minimum shared traits required for MetaSeed injection.
// Raised from 2 → 3: tighter compatibility, fewer borderline bleeds.
// 3 = genuine narrative overlap (dogs+animals share creature,nature = 2 — still blocked as desired)
// Wait — dogs+animals: creature,nature = 2, below 3. Adjust: dogs also gets 'meme' trait.
// With MIN=3: humor+ai share meme,internet = 2 → BLOCKED. dogs+animals share creature,nature,meme = 3 → OK.
const MIN_SHARED_TRAITS = 3

// Categories that BLOCK MetaSeed injection when they are the DOMINANT narrative.
// These are ambient Solana categories — always present, not meaningful trend signals.
// When humor or internet_culture dominates, it's background noise, not a real wave.
// Injecting their terms pollutes every scan indiscriminately.
const METASEED_BLOCKED_AS_DOMINANT = new Set([
  'humor',
  'internet_culture',
  'memes',
])

// Returns true if dominantCat narratively complements tokenCat.
// Neither can be null — call site must handle null before calling this.
export const areCategoriesCompatible = (tokenCat, dominantCat) => {
  if (!tokenCat || !dominantCat) return false
  if (tokenCat === dominantCat) return false  // already in same narrative — no injection needed

  // Hard block: ambient categories should never be treated as meaningful dominant narratives
  if (METASEED_BLOCKED_AS_DOMINANT.has(dominantCat)) return false

  const tokenTraits    = new Set(CATEGORY_TRAITS[tokenCat]    || [])
  const dominantTraits = new Set(CATEGORY_TRAITS[dominantCat] || [])
  if (tokenTraits.size === 0 || dominantTraits.size === 0) return false
  let shared = 0
  for (const trait of dominantTraits) {
    if (tokenTraits.has(trait)) shared++
    if (shared >= MIN_SHARED_TRAITS) return true
  }
  return false
}

// Export for external use (e.g. testing or future admin tooling)
export { METASEED_BLOCKED_AS_DOMINANT }

// Infers category from a list of search terms when V0A detection returned null.
// Useful for tokens with non-Latin names (Japanese, Chinese) where symbol/name
// matching fails but V0 expansion terms reveal the actual narrative.
// Scores ALL categories by keyword overlap and returns the best match.
// Priority is a tiebreaker only — most keyword matches wins.
// Requires at least 2 matching keywords to avoid false positives.
export const inferCategoryFromTerms = (terms = []) => {
  if (!terms.length) return null
  const termSet = new Set(terms.map(t => t.toLowerCase()))
  let bestKey   = null
  let bestScore = 0
  let bestPri   = 99
  for (const [key, cat] of SORTED_CATEGORIES) {
    const overlap = cat.keywords.filter(kw => termSet.has(kw)).length
    if (overlap < 2) continue
    // More matches wins. Equal matches: lower priority number (more specific) wins.
    if (overlap > bestScore || (overlap === bestScore && (cat.priority || 2) < bestPri)) {
      bestKey   = key
      bestScore = overlap
      bestPri   = cat.priority || 2
    }
  }
  return bestKey
}

// ─── Exports ─────────────────────────────────────────────────────

export const getSearchTerms = (symbol) => {
  const upper = symbol.toUpperCase()
  const entry = LORE_MAP[upper]
  if (entry) return entry.terms
  return [symbol.toLowerCase()]
}

export const getConcepts = (symbol) => {
  const upper = symbol.toUpperCase()
  return LORE_MAP[upper]?.concepts || [symbol.toLowerCase()]
}

export const getCategory = (symbol) => {
  const upper = symbol.toUpperCase()
  return LORE_MAP[upper]?.category || null
}

export const getUniverse = (symbol) => {
  const upper = symbol.toUpperCase()
  return LORE_MAP[upper]?.universe || null
}

// ─── Category detection ───────────────────────────────────────────
// Checks symbol, name, and description against NARRATIVE_CATEGORIES keywords.
// Returns the first matching category key or null.
// Priority-sorted so specific categories match before generic ones.
const SORTED_CATEGORIES = Object.entries(NARRATIVE_CATEGORIES)
  .sort((a, b) => (a[1].priority || 2) - (b[1].priority || 2))

// ─── CT Misspelling → Category Map ───────────────────────────────
// Crypto Twitter deliberately misspells political/celebrity names.
// These patterns are stable and intentional — not random typos.
// Used as a second pass in detectCategory when keyword matching fails.
// Format: [regex or string, category]
const CT_VARIANT_PATTERNS = [
  // Trump variants: dunald, drump, trumpy, tump, donal
  [/\bdun+ald\b|\bdrump\b|\btrumpy\b|\btump\b/, 'political'],
  // Obama variants: obema, obonga, obunga, obongo, barry
  [/\bob[eo]m+[ao]\b|\bobunga\b|\bobongo\b/, 'political'],
  // Biden variants: boden, bidun, bidon
  [/\bbod[ei]n\b|\bbidun\b|\bbidon\b/, 'political'],
  // Musk variants: murt, elon variants (murt is CT shorthand)
  [/\bmurt\b/, 'political'],
  // Kamala variants: camala, kamalla
  [/\bcam+ala\b|\bkamall+a\b/, 'political'],
  // Generic political satire signals
  [/tired.{0,10}wunn?ing|tired.{0,10}winn?ing/, 'political'],
  // Pepe/wojak universe
  [/\bwoj+ak\b|\bchad\b|\bnpc\b|\bbasedgod\b/, 'memes'],
  // AI model misspellings/variants
  [/\bgpt\d|\bgrok\d|\bllama\d|\bclaude\d/, 'ai'],
]

export const detectCategory = (symbol, name = '', description = '') => {
  const haystack = `${symbol} ${name} ${description}`.toLowerCase()

  // Pass 1 — keyword matching (fast, exact)
  for (const [key, cat] of SORTED_CATEGORIES) {
    if (cat.keywords.some(kw => haystack.includes(kw))) return key
  }

  // Pass 2 — CT variant/misspelling patterns (regex, catches obfuscated names)
  for (const [pattern, category] of CT_VARIANT_PATTERNS) {
    if (pattern.test(haystack)) return category
  }

  return null
}

export default LORE_MAP