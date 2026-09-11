import { describe, expect, it } from 'vitest';
import { slugOf } from '../src/pipeline/score.js';
describe('slugOf', () => {
    it('ignores trailing slashes, query strings, hash and case', () => {
        expect(slugOf('https://www.linkedin.com/in/morgan-example/')).toBe('morgan-example');
        expect(slugOf('https://www.linkedin.com/in/morgan-example?trk=x')).toBe('morgan-example');
        expect(slugOf('https://www.linkedin.com/in/riley#about')).toBe('riley');
        expect(slugOf('https://www.linkedin.com/company/sample-agency/')).toBe('sample-agency');
    });
});
