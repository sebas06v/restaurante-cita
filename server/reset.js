/** Borra la base y vuelve a sembrar datos de ejemplo. `npm run reset` */
import './env.js';

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, load } from './db.js';

const file = path.join(DATA_DIR, 'db.json');
if (fs.existsSync(file)) fs.rmSync(file);
const state = load();
console.log(`Base reiniciada: ${state.reservations.length} reservas de ejemplo.`);
