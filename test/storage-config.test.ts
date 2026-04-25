import { test, expect, describe } from 'bun:test';
import { 
  validateStorageConfig, 
  isGitTracked, 
  isSupabaseOnly, 
  getStorageTier 
} from '../src/core/storage-config.ts';
import type { StorageConfig } from '../src/core/storage-config.ts';

describe('Storage Configuration', () => {
  const testConfig: StorageConfig = {
    git_tracked: ['people/', 'companies/', 'deals/'],
    supabase_only: ['media/x/', 'media/articles/', 'meetings/transcripts/']
  };

  describe('validateStorageConfig', () => {
    test('should return no warnings for valid config', () => {
      const warnings = validateStorageConfig(testConfig);
      expect(warnings).toEqual([]);
    });

    test('should warn about overlap between git_tracked and supabase_only', () => {
      const invalidConfig: StorageConfig = {
        git_tracked: ['people/', 'media/'],
        supabase_only: ['media/', 'articles/']
      };
      const warnings = validateStorageConfig(invalidConfig);
      expect(warnings).toContain('Directory "media/" appears in both git_tracked and supabase_only');
    });

    test('should warn about paths not ending with /', () => {
      const invalidConfig: StorageConfig = {
        git_tracked: ['people', 'companies/'],
        supabase_only: ['media/x/', 'articles']
      };
      const warnings = validateStorageConfig(invalidConfig);
      expect(warnings).toContain('Directory path "people" should end with "/" for consistency');
      expect(warnings).toContain('Directory path "articles" should end with "/" for consistency');
    });
  });

  describe('Storage tier detection', () => {
    test('should identify git-tracked pages', () => {
      expect(isGitTracked('people/john-doe', testConfig)).toBe(true);
      expect(isGitTracked('companies/acme-corp', testConfig)).toBe(true);
      expect(isGitTracked('deals/series-a', testConfig)).toBe(true);
    });

    test('should identify supabase-only pages', () => {
      expect(isSupabaseOnly('media/x/tweet-123', testConfig)).toBe(true);
      expect(isSupabaseOnly('media/articles/blog-post', testConfig)).toBe(true);
      expect(isSupabaseOnly('meetings/transcripts/standup', testConfig)).toBe(true);
    });

    test('should return false for non-matching paths', () => {
      expect(isGitTracked('media/x/tweet-123', testConfig)).toBe(false);
      expect(isSupabaseOnly('people/john-doe', testConfig)).toBe(false);
    });

    test('should correctly determine storage tier', () => {
      expect(getStorageTier('people/john-doe', testConfig)).toBe('git_tracked');
      expect(getStorageTier('media/x/tweet-123', testConfig)).toBe('supabase_only');
      expect(getStorageTier('projects/random-thing', testConfig)).toBe('unspecified');
    });

    test('should handle edge cases', () => {
      // Exact match shouldn't match (needs prefix)
      expect(isGitTracked('people', testConfig)).toBe(false);
      expect(isGitTracked('people/', testConfig)).toBe(true);
      
      // Partial match shouldn't match
      expect(isGitTracked('peoplex/test', testConfig)).toBe(false);
      expect(isSupabaseOnly('mediax/test', testConfig)).toBe(false);
    });
  });
});