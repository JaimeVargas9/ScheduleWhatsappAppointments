import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

describe('parseEnv', () => {
  it('aplica valores por defecto y normaliza los números de prueba', () => {
    const env = parseEnv({
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: '12345678',
      ALLOWED_TEST_NUMBERS: '+34 600 111 222, 34611222333,,',
    });
    expect(env.PORT).toBe(3000);
    expect(env.OLLAMA_MODEL).toBe('qwen3:8b');
    expect(env.ALLOWED_TEST_NUMBERS).toEqual(['34600111222', '34611222333']);
  });

  it('falla con un mensaje claro si falta la contraseña del panel', () => {
    expect(() => parseEnv({ ADMIN_USER: 'admin' })).toThrow(/ADMIN_PASSWORD/);
  });
});
