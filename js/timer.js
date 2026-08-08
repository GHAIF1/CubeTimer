/*!
* CubeTimer — Rubik's Cube timer app
* Pure vanilla JavaScript, no dependencies.
*/
(function () {
    'use strict';

    // Marker so CSS only hides reveal-animated content when JS is active.
    document.documentElement.classList.add('js');

    // ------------------------------------------------------------------
    // Configuration
    // ------------------------------------------------------------------

    var STORAGE_KEY = 'cubeTimer.solves';
    var WELCOME_KEY = 'cubeTimer.welcomeSeen';
    // Official WCA 3x3x3 single world record: Max Park, 3.13 s (June 2023)
    var WR_MS = 3130;
    var RECENT_COUNT = 5;
    var LEADERBOARD_COUNT = 10;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    var solves = loadSolves();

    var running = false;
    var startAt = 0;
    var elapsedMs = 0;
    var rafId = null;

    // ------------------------------------------------------------------
    // DOM references
    // ------------------------------------------------------------------

    var timerDisplay = document.getElementById('timerDisplay');
    var timerHint = document.getElementById('timerHint');
    var timerStage = document.getElementById('timerStage');
    var latestSolve = document.getElementById('latestSolve');
    var recentList = document.getElementById('recentList');
    var recentEmpty = document.getElementById('recentEmpty');
    var wrBarFill = document.getElementById('wrBarFill');
    var wrPace = document.getElementById('wrPace');
    var statBest = document.getElementById('statBest');
    var statAvg = document.getElementById('statAvg');
    var statCount = document.getElementById('statCount');
    var statTotal = document.getElementById('statTotal');
    var solvesList = document.getElementById('solvesList');
    var solvesEmpty = document.getElementById('solvesEmpty');
    var leaderboard = document.getElementById('leaderboard');
    var leaderboardEmpty = document.getElementById('leaderboardEmpty');
    var popup = document.getElementById('welcomePopup');

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function loadSolves() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return [];
            }
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) {
                return [];
            }
            return arr.filter(function (s) {
                return s &&
                    typeof s.time === 'number' && isFinite(s.time) && s.time >= 0 &&
                    typeof s.date === 'string' &&
                    typeof s.id === 'string';
            });
        } catch (e) {
            return [];
        }
    }

    function saveSolves() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(solves));
        } catch (e) {
            /* storage unavailable — solve stays in memory only */
        }
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    // Live timer: 3 decimals, mm:ss.xxx once past a minute.
    function formatLive(ms) {
        var totalSec = ms / 1000;
        if (ms < 60000) {
            return totalSec.toFixed(3);
        }
        var m = Math.floor(totalSec / 60);
        return m + ':' + pad2((totalSec - m * 60).toFixed(3));
    }

    // Stored solve: 2 decimals, mm:ss.cc once past a minute.
    function formatTime(ms) {
        var totalSec = ms / 1000;
        if (ms < 60000) {
            return totalSec.toFixed(2);
        }
        var m = Math.floor(totalSec / 60);
        return m + ':' + pad2((totalSec - m * 60).toFixed(2));
    }

    function formatDuration(ms) {
        var sec = Math.round(ms / 1000);
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        var s = sec % 60;
        if (h > 0) {
            return h + 'h ' + m + 'm';
        }
        if (m > 0) {
            return m + 'm ' + pad2(s) + 's';
        }
        return s + 's';
    }

    // Chart duration: "12.34s" under a minute, "1m 10.12s" once past it.
    function formatChartTime(ms) {
        var totalSec = ms / 1000;
        if (ms < 60000) {
            return totalSec.toFixed(2) + 's';
        }
        var m = Math.floor(totalSec / 60);
        var s = (totalSec - m * 60).toFixed(2);
        return m + 'm ' + s + 's';
    }

    function formatDate(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) {
            return '—';
        }
        return d.toLocaleString(undefined, {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function newestFirst() {
        return solves.slice().sort(function (a, b) {
            return b.date.localeCompare(a.date);
        });
    }

    function fastestFirst() {
        return solves.slice().sort(function (a, b) {
            return a.time - b.time;
        });
    }

    // ------------------------------------------------------------------
    // Timer
    // ------------------------------------------------------------------

    function tick() {
        if (!running) {
            return;
        }
        elapsedMs = performance.now() - startAt;
        updateTimerUI();
        rafId = requestAnimationFrame(tick);
    }

    function updateTimerUI() {
        timerDisplay.textContent = formatLive(elapsedMs);
        updateWrBar();
    }

    function updateWrBar() {
        var ratio = elapsedMs / WR_MS;
        var over = ratio > 1;
        var pct;

        // Below the record the bar fills up to 100 %; once the record is
        // exceeded the bar shrinks to show the record has been beaten.
        if (over) {
            pct = (1 / ratio) * 100;
        } else {
            pct = ratio * 100;
        }

        wrBarFill.style.width = Math.min(100, pct) + '%';
        wrBarFill.classList.toggle('over', over);
        timerDisplay.classList.toggle('over-record', over);

        if (elapsedMs <= 0) {
            wrPace.textContent = 'compare your solve with the fastest in the world';
        } else if (running) {
            wrPace.textContent = over ? 'past the world record' : 'on pace to beat it';
        } else {
            wrPace.textContent = over ? 'world record exceeded' : 'under the world record — nice!';
        }
    }

    function start() {
        running = true;
        startAt = performance.now();
        elapsedMs = 0;
        timerDisplay.classList.add('running');
        updateTimerUI();
        rafId = requestAnimationFrame(tick);
    }

    function stop() {
        running = false;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        elapsedMs = performance.now() - startAt;
        timerDisplay.classList.remove('running');
        updateTimerUI();

        // Ignore sub-50 ms "solves" — almost always an accidental double-tap.
        if (elapsedMs >= 50) {
            saveSolve(Math.round(elapsedMs));
        }
    }

    function toggle() {
        if (running) {
            stop();
        } else {
            start();
        }
    }

    function saveSolve(time) {
        var solve = {
            id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
            time: time,
            date: new Date().toISOString()
        };
        solves.unshift(solve);
        saveSolves();
        renderAll();
        // Optional online layer (js/firebase.js) — never required for the timer.
        if (window.CubeTimer && typeof window.CubeTimer.onSolveSaved === 'function') {
            window.CubeTimer.onSolveSaved(solve);
        }
    }

    function deleteSolve(id) {
        solves = solves.filter(function (s) {
            return s.id !== id;
        });
        saveSolves();
        renderAll();
        // Optional online layer (js/firebase.js) — never required for the timer.
        if (window.CubeTimer && typeof window.CubeTimer.onSolveDeleted === 'function') {
            window.CubeTimer.onSolveDeleted(id);
        }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function renderAll() {
        renderLatest();
        renderRecent();
        renderStats();
        renderChart();
        renderSolves();
        renderLeaderboard();
    }

    function renderLatest() {
        if (solves.length === 0) {
            latestSolve.textContent = '—';
            return;
        }
        latestSolve.textContent = formatTime(newestFirst()[0].time);
    }

    function renderRecent() {
        var recent = newestFirst().slice(0, RECENT_COUNT);
        recentList.innerHTML = '';
        recentEmpty.hidden = recent.length > 0;

        recent.forEach(function (s) {
            var li = document.createElement('li');
            li.innerHTML =
                '<span class="recent-time">' + formatTime(s.time) + '</span>' +
                '<span class="recent-date">' + formatDate(s.date) + '</span>';
            recentList.appendChild(li);
        });
    }

    function renderStats() {
        var count = solves.length;
        if (count === 0) {
            statBest.textContent = '—';
            statAvg.textContent = '—';
            statCount.textContent = '0';
            statTotal.textContent = '—';
            return;
        }

        var times = solves.map(function (s) { return s.time; });
        var total = times.reduce(function (a, b) { return a + b; }, 0);

        statBest.textContent = formatTime(Math.min.apply(null, times));
        statAvg.textContent = formatTime(total / count);
        statCount.textContent = String(count);
        statTotal.textContent = formatDuration(total);
    }

    function renderSolves() {
        var items = newestFirst();
        solvesList.innerHTML = '';
        solvesEmpty.hidden = items.length > 0;

        items.forEach(function (s) {
            var li = document.createElement('li');
            li.className = 'solve-row';
            li.innerHTML =
                '<button class="solve-delete" data-id="' + s.id + '" aria-label="Delete solve ' + formatTime(s.time) + '">' +
                '<i class="fas fa-trash-alt"></i></button>' +
                '<span class="solve-time">' + formatTime(s.time) + '</span>' +
                '<span class="solve-date">' + formatDate(s.date) + '</span>';
            solvesList.appendChild(li);
        });
    }

    function renderLeaderboard() {
        var top = fastestFirst().slice(0, LEADERBOARD_COUNT);
        leaderboard.innerHTML = '';
        leaderboardEmpty.hidden = top.length > 0;

        top.forEach(function (s, i) {
            var li = document.createElement('li');
            li.innerHTML =
                '<span class="rank rank-' + (i + 1) + '">' + (i + 1) + '</span>' +
                '<span class="solve-time">' + formatTime(s.time) + '</span>' +
                '<span class="solve-date">' + formatDate(s.date) + '</span>';
            leaderboard.appendChild(li);
        });
    }

    // ------------------------------------------------------------------
    // Statistics chart (Chart.js)
    // ------------------------------------------------------------------

    var chartView = 'all'; // '10' | '30' | 'all'
    var statsChart = null;
    var chartButtons = [].slice.call(document.querySelectorAll('.chart-btn'));
    var chartEmpty = document.getElementById('chartEmpty');

    function buildChartData() {
        // solves[] is newest-first; the chart reads oldest → newest so the
        // line shows progress over time, labelled by absolute solve number.
        var all = solves.slice().reverse();
        var start = 0;
        if (chartView === '10' || chartView === '30') {
            start = Math.max(0, all.length - parseInt(chartView, 10));
        }
        var series = all.slice(start);
        return {
            labels: series.map(function (_, i) {
                return String(start + i + 1);
            }),
            data: series.map(function (s) {
                return +(s.time / 1000).toFixed(3); // seconds
            })
        };
    }

    // Created lazily so Chart.js can measure the (hidden) statistics view
    // correctly the first time the chart actually renders.
    function ensureChart() {
        if (statsChart || typeof Chart === 'undefined') {
            return statsChart;
        }
        var canvas = document.getElementById('statsChart');
        if (!canvas) {
            return null;
        }

        Chart.defaults.font.family = '"JetBrains Mono", monospace';
        var reduceMotion = window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        statsChart = new Chart(canvas, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Solve time',
                    data: [],
                    borderColor: '#ffffff',
                    borderWidth: 2,
                    tension: 0.35,
                    fill: false,
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: '#0a0d13',
                    pointBorderWidth: 1.5,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointHitRadius: 14,
                    pointHoverBackgroundColor: '#ffffff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: reduceMotion ? false : { duration: 600 },
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(10, 13, 19, 0.94)',
                        titleColor: '#eef1f6',
                        bodyColor: '#9aa3b2',
                        borderColor: 'rgba(255, 255, 255, 0.12)',
                        borderWidth: 1,
                        padding: 10,
                        cornerRadius: 8,
                        displayColors: false,
                        callbacks: {
                            title: function (items) {
                                return items.length ? 'Solve #' + items[0].label : '';
                            },
                            label: function (ctx) {
                                return formatChartTime(Math.round(ctx.parsed.y * 1000));
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        border: { display: false },
                        ticks: {
                            color: '#9aa3b2',
                            font: { size: 11 },
                            maxRotation: 0,
                            autoSkip: true
                        }
                    },
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        border: { display: false },
                        ticks: {
                            color: '#9aa3b2',
                            font: { size: 11 },
                            callback: function (value) {
                                var total = Math.round(value);
                                if (total < 60) {
                                    return total + 's';
                                }
                                var m = Math.floor(total / 60);
                                var s = total % 60;
                                return m + 'm' + (s > 0 ? ' ' + s + 's' : '');
                            }
                        }
                    }
                }
            }
        });
        return statsChart;
    }

    function renderChart() {
        if (chartEmpty) {
            chartEmpty.hidden = solves.length > 0;
        }
        var chart = ensureChart();
        if (!chart) {
            return;
        }
        var d = buildChartData();
        chart.data.labels = d.labels;
        chart.data.datasets[0].data = d.data;
        chart.update();
    }

    chartButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
            chartView = btn.getAttribute('data-range');
            chartButtons.forEach(function (b) {
                var active = b === btn;
                b.classList.toggle('active', active);
                b.setAttribute('aria-pressed', active ? 'true' : 'false');
            });
            renderChart();
            btn.blur();
        });
    });

    // ------------------------------------------------------------------
    // Welcome popup (once per visit)
    // ------------------------------------------------------------------

    function isWelcomeSeen() {
        try {
            return !!sessionStorage.getItem(WELCOME_KEY);
        } catch (e) {
            return false;
        }
    }

    function markWelcomeSeen() {
        try {
            sessionStorage.setItem(WELCOME_KEY, '1');
        } catch (e) {
            /* ignore */
        }
    }

    function showWelcome() {
        if (isWelcomeSeen()) {
            return;
        }
        // Shown synchronously — the entrance animation is driven by CSS,
        // so this works even where requestAnimationFrame is throttled.
        popup.classList.add('show');
        var closeBtn = document.getElementById('welcomeClose');
        if (closeBtn && closeBtn.focus) {
            closeBtn.focus({ preventScroll: true });
        }
    }

    function closeWelcome() {
        popup.classList.remove('show');
        markWelcomeSeen();
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    // Space bar starts / stops the timer.
    document.addEventListener('keydown', function (e) {
        if (e.code !== 'Space' || e.repeat) {
            return;
        }
        if (popup.classList.contains('show')) {
            return;
        }
        var t = e.target;
        if (t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
            return;
        }
        e.preventDefault();
        toggle();
    });

    // Tap / click on the timer (important for mobile without a keyboard).
    timerStage.addEventListener('click', function () {
        if (!popup.classList.contains('show')) {
            toggle();
        }
    });
    // Enter on the focused timer toggles it; Space is handled at document level.
    timerStage.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.repeat && !popup.classList.contains('show')) {
            e.preventDefault();
            toggle();
        }
    });

    // Delete buttons (event delegation).
    solvesList.addEventListener('click', function (e) {
        var btn = e.target.closest('.solve-delete');
        if (!btn) {
            return;
        }
        deleteSolve(btn.getAttribute('data-id'));
        btn.blur();
    });

    // Welcome popup close.
    document.getElementById('welcomeClose').addEventListener('click', closeWelcome);
    popup.addEventListener('click', function (e) {
        if (e.target === popup) {
            closeWelcome();
        }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && popup.classList.contains('show')) {
            closeWelcome();
        }
    });

    // Touch-friendly hint.
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
        timerHint.textContent = 'Tap to start';
    }

    // ------------------------------------------------------------------
    // View switching
    // ------------------------------------------------------------------
    // The navbar is the ONLY way to change menus: inactive views are hidden
    // (display: none), so scrolling can never navigate to another menu.

    var navLinks = [].slice.call(document.querySelectorAll('#mainNav a[href^="#"]'));
    var views = [].slice.call(document.querySelectorAll('.view'));

    function switchView(id) {
        if (id === 'page-top') {
            id = 'stopwatch';
        }
        var target = document.getElementById(id);
        if (!target) {
            return;
        }
        views.forEach(function (v) {
            v.classList.toggle('active', v === target);
        });
        navLinks.forEach(function (link) {
            var isActive = link.classList.contains('nav-link') && link.getAttribute('href') === '#' + id;
            link.classList.toggle('active', isActive);
            if (link.classList.contains('nav-link')) {
                if (isActive) {
                    link.setAttribute('aria-current', 'page');
                } else {
                    link.removeAttribute('aria-current');
                }
            }
        });
        // A hidden view has zero size — let the chart measure itself once the
        // statistics view actually becomes visible.
        if (statsChart && id === 'statistics') {
            statsChart.resize();
        }
        window.scrollTo(0, 0);
    }

    navLinks.forEach(function (link) {
        link.addEventListener('click', function (e) {
            var href = link.getAttribute('href');
            if (href && href.charAt(0) === '#') {
                e.preventDefault();
                switchView(href.slice(1));
            }
        });
    });

    // Footer year.
    var footerYear = document.getElementById('footerYear');
    if (footerYear) {
        footerYear.textContent = String(new Date().getFullYear());
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------

    renderAll();
    switchView('stopwatch');
    showWelcome();
})();
