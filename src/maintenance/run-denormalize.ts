// Standalone entry for `npm run denormalize:fdc`.
import { pool } from '../db.js';
import { denormalizeFdc } from './denormalize-fdc.js';

denormalizeFdc()
  .then(() => pool.end())
  .then(() => console.log('Denormalize complete.'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
