(function() {
    "use strict";

    window.TimelineSettings = {
        PX_PER_SECOND: 40,
        MAX_DURATION: 300,
        TIMELINE_OFFSET: 30,
        
        formatTime(time) {
            const mins = Math.floor(time / 60).toString().padStart(2, '0');
            const secs = Math.floor(time % 60).toString().padStart(2, '0');
            const ms = Math.floor((time % 1) * 1000).toString().padStart(3, '0');
            return `${mins}:${secs}.${ms}`;
        }
    };
})();
