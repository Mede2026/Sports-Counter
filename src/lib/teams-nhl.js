// Les 32 équipes de la LNH, telles que les renvoie ESPN (…/hockey/nhl/teams,
// saison 2026-27). Intégrées à l'app parce que cette adresse d'ESPN est
// illisible depuis une application : son pare-feu refuse le relais Rust et elle
// n'autorise pas la lecture depuis WebView2. Les identifiants sont ceux d'ESPN,
// les mêmes que dans les résultats des matchs. `alt` est leur couleur
// secondaire (alternateColor).
const LOGO = (abbr) => `https://a.espncdn.com/i/teamlogos/nhl/500/${abbr.toLowerCase()}.png`;

export const NHL_TEAMS = [
  { id: "25", abbr: "ANA", name: "Anaheim Ducks", short: "Ducks", color: '#fc4c02', alt: '#000000' },
  { id: "1", abbr: "BOS", name: "Boston Bruins", short: "Bruins", color: '#231f20', alt: '#fdb71a' },
  { id: "2", abbr: "BUF", name: "Buffalo Sabres", short: "Sabres", color: '#00468b', alt: '#fdb71a' },
  { id: "3", abbr: "CGY", name: "Calgary Flames", short: "Flames", color: '#dd1a32', alt: '#000000' },
  { id: "7", abbr: "CAR", name: "Carolina Hurricanes", short: "Hurricanes", color: '#e30426', alt: '#000000' },
  { id: "4", abbr: "CHI", name: "Chicago Blackhawks", short: "Blackhawks", color: '#e31937', alt: '#000000' },
  { id: "17", abbr: "COL", name: "Colorado Avalanche", short: "Avalanche", color: '#860038', alt: '#005ea3' },
  { id: "29", abbr: "CBJ", name: "Columbus Blue Jackets", short: "Blue Jackets", color: '#002d62', alt: '#e31937' },
  { id: "9", abbr: "DAL", name: "Dallas Stars", short: "Stars", color: '#20864c', alt: '#000000' },
  { id: "5", abbr: "DET", name: "Detroit Red Wings", short: "Red Wings", color: '#e30526', alt: '#ffffff' },
  { id: "6", abbr: "EDM", name: "Edmonton Oilers", short: "Oilers", color: '#00205b', alt: '#ff4c00' },
  { id: "26", abbr: "FLA", name: "Florida Panthers", short: "Panthers", color: '#e51937', alt: '#002d62' },
  { id: "8", abbr: "LA", name: "Los Angeles Kings", short: "Kings", color: '#121212', alt: '#a2aaad' },
  { id: "30", abbr: "MIN", name: "Minnesota Wild", short: "Wild", color: '#124734', alt: '#ae122a' },
  { id: "10", abbr: "MTL", name: "Montreal Canadiens", short: "Canadiens", color: '#c41230', alt: '#013a81' },
  { id: "27", abbr: "NSH", name: "Nashville Predators", short: "Predators", color: '#fdba31', alt: '#002d62' },
  { id: "11", abbr: "NJ", name: "New Jersey Devils", short: "Devils", color: '#e30b2b', alt: '#000000' },
  { id: "12", abbr: "NYI", name: "New York Islanders", short: "Islanders", color: '#00529b', alt: '#f47d31' },
  { id: "13", abbr: "NYR", name: "New York Rangers", short: "Rangers", color: '#0056ae', alt: '#e51937' },
  { id: "14", abbr: "OTT", name: "Ottawa Senators", short: "Senators", color: '#dd1a32', alt: '#b79257' },
  { id: "15", abbr: "PHI", name: "Philadelphia Flyers", short: "Flyers", color: '#fe5823', alt: '#000000' },
  { id: "16", abbr: "PIT", name: "Pittsburgh Penguins", short: "Penguins", color: '#000000', alt: '#fdb71a' },
  { id: "18", abbr: "SJ", name: "San Jose Sharks", short: "Sharks", color: '#00788a', alt: '#070707' },
  { id: "124292", abbr: "SEA", name: "Seattle Kraken", short: "Kraken", color: '#000d33', alt: '#a3dce4' },
  { id: "19", abbr: "STL", name: "St. Louis Blues", short: "Blues", color: '#0070b9', alt: '#fdb71a' },
  { id: "20", abbr: "TB", name: "Tampa Bay Lightning", short: "Lightning", color: '#003e7e', alt: '#ffffff' },
  { id: "21", abbr: "TOR", name: "Toronto Maple Leafs", short: "Maple Leafs", color: '#003e7e', alt: '#ffffff' },
  { id: "129764", abbr: "UTAH", name: "Utah Mammoth", short: "Mammoth", color: '#000000', alt: '#7ab2e1' },
  { id: "22", abbr: "VAN", name: "Vancouver Canucks", short: "Canucks", color: '#003e7e', alt: '#008752' },
  { id: "37", abbr: "VGK", name: "Vegas Golden Knights", short: "Golden Knights", color: '#344043', alt: '#b4975a' },
  { id: "23", abbr: "WSH", name: "Washington Capitals", short: "Capitals", color: '#d71830', alt: '#0b1f41' },
  { id: "28", abbr: "WPG", name: "Winnipeg Jets", short: "Jets", color: '#002d62', alt: '#c41230' },
].map((t) => ({ ...t, logo: LOGO(t.abbr) }));
