/**
 * Carga el .env ANTES que cualquier otro módulo.
 *
 * En ESM los `import` se evalúan antes del cuerpo del módulo que importa.
 * Si se llama a loadEnvFile() dentro de index.js, cualquier módulo que lea
 * process.env al importarse —la configuración, el transporte de correo, la
 * cola— ya lo leyó vacío y se quedó con los valores por defecto.
 *
 * Por eso esto vive en su propio archivo y se importa de PRIMERO: el orden
 * de evaluación sigue el orden de las declaraciones de import.
 *
 * En Render no hace falta —las variables ya están en el entorno del
 * proceso—, pero en local es la diferencia entre que el .env sirva o sea
 * decorativo.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(raiz, '.env'));
} catch {
  /* sin .env: se usan las variables del entorno, o los valores por defecto */
}
