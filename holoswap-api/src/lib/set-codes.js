// Maps printed-on-card three-letter set codes (uppercase) to tcgdex set_ids.
// Single source of truth — both vending and seller-submissions routes import this.
const SET_CODE_MAP = {
  // Scarlet & Violet era
  'SVI': 'sv01', 'PAL': 'sv02', 'OBF': 'sv03', 'MEW': 'sv03.5',
  'PAR': 'sv04', 'PAF': 'sv04.5', 'TEF': 'sv05', 'TWM': 'sv06',
  'SFA': 'sv06.5', 'SCR': 'sv07', 'SSP': 'sv08', 'PRE': 'sv08.5',
  'JTG': 'sv09', 'DRI': 'sv10', 'BLK': 'sv10.5b', 'WHT': 'sv10.5w',
  'SVP': 'svp', 'SVE': 'sve',
  // Pokemon TCG Pocket
  'A1': 'A1', 'A1A': 'A1a', 'A2': 'A2', 'A2A': 'A2a', 'A3': 'A3',
  'P-A': 'P-A',
  // Mega Evolution
  'MEG': 'me01', 'PFL': 'me02', 'MEP': 'mep',
  // Sword & Shield era
  'SSH': 'swsh1', 'RCL': 'swsh2', 'DAA': 'swsh3', 'CPA': 'swsh3.5', 'VIV': 'swsh4',
  'SHF': 'swsh4.5', 'BST': 'swsh5', 'CRE': 'swsh6', 'EVS': 'swsh7', 'CEL': 'swsh7.5',
  'FST': 'swsh8', 'BRS': 'swsh9', 'ASR': 'swsh10', 'PGO': 'swsh10.5',
  'LOR': 'swsh11', 'SIT': 'swsh12', 'CRZ': 'swsh12.5',
  // Sun & Moon era
  'SUM': 'sm1', 'GRI': 'sm2', 'BUS': 'sm3', 'SLG': 'sm35',
  'CIN': 'sm4', 'UPR': 'sm5', 'FLI': 'sm6', 'CES': 'sm7',
  'LOT': 'sm8', 'TEU': 'sm9', 'UNB': 'sm10', 'UNM': 'sm11',
  'CEC': 'sm12',
  // XY era
  'XY': 'xy1', 'FLF': 'xy2', 'FFI': 'xy3', 'PHF': 'xy4',
  'PRC': 'xy5', 'ROS': 'xy6', 'AOR': 'xy7', 'BKT': 'xy8',
  'BKP': 'xy9', 'FCO': 'xy10', 'STS': 'xy11', 'EVO': 'xy12',
  // Base sets
  'BS': 'base1', 'JU': 'base2', 'FO': 'base3', 'BS2': 'base4',
  'TR': 'base5', 'GY': 'base6',
};

module.exports = { SET_CODE_MAP };
