#!/usr/bin/env python3
import os
import time

def main():
    trigger_dir = "temp"
    trigger_path = os.path.join(trigger_dir, "agent_trigger.txt")
    
    # Ensure any stale trigger is removed on startup
    if os.path.exists(trigger_path):
        try:
            os.remove(trigger_path)
        except Exception as e:
            print(f"Error removing stale trigger file: {e}")
            
    print("Agent Listener active. Waiting for 'Send to Agent' click in browser...", flush=True)
    
    try:
        while True:
            if os.path.exists(trigger_path):
                print("Trigger detected! Waking up Agent Conductor...", flush=True)
                # Remove file to reset the trigger state
                try:
                    os.remove(trigger_path)
                except Exception as e:
                    print(f"Warning: Could not remove trigger file: {e}")
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nAgent Listener stopped.")

if __name__ == "__main__":
    main()
