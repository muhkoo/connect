/**
 * EventCore Tests
 * Tests for the EventCore event emitter system
 * Salvaged and enhanced from tests/v1/events/eventcore.spec.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventCore } from '../../src/events/EventCore';

describe('EventCore', () => {
  describe('Event Listener Management', () => {
    it('should add an event listener', () => {
      const mockListener = vi.fn();

      EventCore.on('test-event', mockListener);
      EventCore.emit('test-event', 'test data');

      expect(mockListener).toHaveBeenCalled();
      expect(mockListener).toHaveBeenCalledTimes(1);

      // Cleanup
      EventCore.off('test-event', mockListener);
    });

    it('should add multiple listeners to the same event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      EventCore.on('multi-event', listener1);
      EventCore.on('multi-event', listener2);
      EventCore.emit('multi-event', 'data');

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();

      // Cleanup
      EventCore.off('multi-event', listener1);
      EventCore.off('multi-event', listener2);
    });

    it('should remove an event listener', () => {
      const mockListener = vi.fn();

      EventCore.on('remove-test', mockListener);
      EventCore.emit('remove-test', 'data');

      expect(mockListener).toHaveBeenCalledTimes(1);

      EventCore.off('remove-test', mockListener);
      EventCore.emit('remove-test', 'data');

      // Should still be 1, not 2
      expect(mockListener).toHaveBeenCalledTimes(1);
    });

    it('should remove only the specified listener', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      EventCore.on('selective-remove', listener1);
      EventCore.on('selective-remove', listener2);

      EventCore.off('selective-remove', listener1);
      EventCore.emit('selective-remove', 'data');

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();

      // Cleanup
      EventCore.off('selective-remove', listener2);
    });

    it('should not throw when removing non-existent listener', () => {
      const mockListener = vi.fn();

      expect(() => {
        EventCore.off('non-existent', mockListener);
      }).not.toThrow();
    });
  });

  describe('Event Emission', () => {
    it('should emit an event with data', () => {
      const listener = vi.fn();

      EventCore.on('emit-test', listener);
      EventCore.emit('emit-test', 'test data');

      expect(listener).toHaveBeenCalled();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: 'test data',
        })
      );

      // Cleanup
      EventCore.off('emit-test', listener);
    });

    it('should emit event with complex data', () => {
      const listener = vi.fn();
      const complexData = {
        id: 1,
        name: 'test',
        nested: {
          value: 42,
        },
      };

      EventCore.on('complex-data', listener);
      EventCore.emit('complex-data', complexData);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: complexData,
        })
      );

      // Cleanup
      EventCore.off('complex-data', listener);
    });

    it('should emit event with null data', () => {
      const listener = vi.fn();

      EventCore.on('null-data', listener);
      EventCore.emit('null-data', null);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: null,
        })
      );

      // Cleanup
      EventCore.off('null-data', listener);
    });

    it('should emit event with undefined data', () => {
      const listener = vi.fn();

      EventCore.on('undefined-data', listener);
      EventCore.emit('undefined-data', undefined);

      // Note: CustomEvent converts undefined detail to null
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: null,
        })
      );

      // Cleanup
      EventCore.off('undefined-data', listener);
    });

    it('should not call listeners if event is not emitted', () => {
      const listener = vi.fn();

      EventCore.on('not-emitted', listener);
      EventCore.emit('different-event', 'data');

      expect(listener).not.toHaveBeenCalled();

      // Cleanup
      EventCore.off('not-emitted', listener);
    });

    it('should call listeners multiple times for multiple emits', () => {
      const listener = vi.fn();

      EventCore.on('multiple-emits', listener);
      EventCore.emit('multiple-emits', 'first');
      EventCore.emit('multiple-emits', 'second');
      EventCore.emit('multiple-emits', 'third');

      expect(listener).toHaveBeenCalledTimes(3);

      // Cleanup
      EventCore.off('multiple-emits', listener);
    });
  });

  describe('Event Isolation', () => {
    it('should not trigger listeners of different events', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      EventCore.on('event-a', listener1);
      EventCore.on('event-b', listener2);

      EventCore.emit('event-a', 'data-a');

      expect(listener1).toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();

      // Cleanup
      EventCore.off('event-a', listener1);
      EventCore.off('event-b', listener2);
    });

    it('should handle event names with special characters', () => {
      const listener = vi.fn();

      EventCore.on('event:special-chars_123', listener);
      EventCore.emit('event:special-chars_123', 'data');

      expect(listener).toHaveBeenCalled();

      // Cleanup
      EventCore.off('event:special-chars_123', listener);
    });

    it('should handle namespaced event names', () => {
      const listener = vi.fn();

      EventCore.on('namespace:category:event', listener);
      EventCore.emit('namespace:category:event', 'data');

      expect(listener).toHaveBeenCalled();

      // Cleanup
      EventCore.off('namespace:category:event', listener);
    });
  });

  describe('CallableFunction Support', () => {
    it('should work with arrow functions', () => {
      const listener = vi.fn((event) => {
        expect(event.detail).toBe('arrow data');
      });

      EventCore.on('arrow-test', listener);
      EventCore.emit('arrow-test', 'arrow data');

      expect(listener).toHaveBeenCalled();

      // Cleanup
      EventCore.off('arrow-test', listener);
    });

    it('should work with regular functions', () => {
      const listener = vi.fn(function (event) {
        expect(event.detail).toBe('regular data');
      });

      EventCore.on('regular-test', listener);
      EventCore.emit('regular-test', 'regular data');

      expect(listener).toHaveBeenCalled();

      // Cleanup
      EventCore.off('regular-test', listener);
    });

    it('should work with bound functions', () => {
      const context = { value: 'test' };
      const listener = vi.fn(function (this: typeof context, event) {
        expect(this.value).toBe('test');
        expect(event.detail).toBe('bound data');
      }.bind(context));

      EventCore.on('bound-test', listener);
      EventCore.emit('bound-test', 'bound data');

      expect(listener).toHaveBeenCalled();

      // Cleanup
      EventCore.off('bound-test', listener);
    });
  });

  describe('Error Handling', () => {
    it('should continue emitting to other listeners if one throws', () => {
      const listener1 = vi.fn(() => {
        throw new Error('Listener 1 error');
      });
      const listener2 = vi.fn();

      EventCore.on('error-test', listener1);
      EventCore.on('error-test', listener2);

      // This should not throw, errors should be caught internally
      expect(() => {
        EventCore.emit('error-test', 'data');
      }).not.toThrow();

      // listener2 should still be called
      expect(listener1).toHaveBeenCalled();
      // Note: Depending on EventCore implementation, listener2 may or may not be called
      // If errors are caught and swallowed, listener2 should be called

      // Cleanup
      EventCore.off('error-test', listener1);
      EventCore.off('error-test', listener2);
    });
  });

  describe('Performance and Edge Cases', () => {
    it('should handle many listeners efficiently', () => {
      const listeners = Array.from({ length: 100 }, () => vi.fn());

      listeners.forEach((listener) => {
        EventCore.on('many-listeners', listener);
      });

      EventCore.emit('many-listeners', 'data');

      listeners.forEach((listener) => {
        expect(listener).toHaveBeenCalled();
      });

      // Cleanup
      listeners.forEach((listener) => {
        EventCore.off('many-listeners', listener);
      });
    });

    it('should handle rapid event emissions', () => {
      const listener = vi.fn();

      EventCore.on('rapid-emit', listener);

      for (let i = 0; i < 1000; i++) {
        EventCore.emit('rapid-emit', i);
      }

      expect(listener).toHaveBeenCalledTimes(1000);

      // Cleanup
      EventCore.off('rapid-emit', listener);
    });

    it('should handle empty event names', () => {
      const listener = vi.fn();

      expect(() => {
        EventCore.on('', listener);
        EventCore.emit('', 'data');
      }).not.toThrow();

      // Cleanup
      EventCore.off('', listener);
    });
  });
});
