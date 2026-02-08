/**
 * Kirie Canvas Client
 * Connects to the canvas SSE endpoint for real-time A2UI updates.
 */
(function() {
  'use strict';

  var state = {};
  var evtSource = null;
  var statusEl = document.getElementById('status');
  var stateView = document.getElementById('state-view');
  var actionInput = document.getElementById('action-input');
  var actionBtn = document.getElementById('action-btn');

  function connect() {
    var baseUrl = window.location.origin;
    evtSource = new EventSource(baseUrl + '/__kirie__/canvas/events');

    evtSource.onopen = function() {
      statusEl.textContent = 'Connected';
      statusEl.className = 'connected';
    };

    evtSource.onerror = function() {
      statusEl.textContent = 'Disconnected';
      statusEl.className = 'disconnected';
      evtSource.close();
      // Reconnect after 3 seconds
      setTimeout(connect, 3000);
    };

    evtSource.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch (err) {
        console.error('Failed to parse canvas message:', err);
      }
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'push':
        Object.assign(state, msg.data);
        render();
        break;
      case 'reset':
        state = {};
        render();
        break;
      case 'navigate':
        if (msg.url) window.location.href = msg.url;
        break;
      case 'eval':
        if (msg.code) {
          try { eval(msg.code); } catch (e) { console.error('Canvas eval error:', e); }
        }
        break;
      case 'snapshot':
        // Send snapshot back via POST
        var snapshot = msg.format === 'text' ? document.body.innerText : document.body.innerHTML;
        fetch('/__kirie__/canvas/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'snapshot_result', data: snapshot }),
        }).catch(function() {});
        break;
    }
  }

  function render() {
    var keys = Object.keys(state);
    if (keys.length === 0) {
      stateView.textContent = 'No data yet.';
      return;
    }

    // If state has an 'html' key, render it as HTML
    if (state.html) {
      stateView.innerHTML = state.html;
      return;
    }

    // If state has a 'markdown' key, show it as text (basic)
    if (state.markdown) {
      stateView.textContent = state.markdown;
      return;
    }

    // Default: show JSON state
    stateView.textContent = JSON.stringify(state, null, 2);
  }

  function sendAction() {
    var text = actionInput.value.trim();
    if (!text) return;
    fetch('/__kirie__/canvas/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user_action', text: text }),
    }).catch(function(err) {
      console.error('Failed to send action:', err);
    });
    actionInput.value = '';
  }

  actionBtn.addEventListener('click', sendAction);
  actionInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendAction();
  });

  // Global API for WebView bridge
  window.Kirie = {
    canvas: { state: state },
    postMessage: function(msg) {
      fetch('/__kirie__/canvas/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      }).catch(function() {});
    },
    getState: function() { return JSON.parse(JSON.stringify(state)); },
  };

  // Auto-connect
  connect();
})();
