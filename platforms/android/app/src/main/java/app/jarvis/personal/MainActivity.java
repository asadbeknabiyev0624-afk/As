package app.jarvis.personal;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Locale;
import org.json.JSONObject;

/** HTTPS client for the owner's PC. AI and personal data remain on that PC. */
public final class MainActivity extends Activity implements RecognitionListener {
    private static final int MICROPHONE_REQUEST = 41;
    private static final int BACKGROUND = Color.rgb(9, 14, 22);
    private WebView webView;
    private FrameLayout content;
    private SharedPreferences preferences;
    private volatile String serverOrigin;
    private boolean trustedPage;
    private boolean loadingFailed;
    private boolean foreground;
    private boolean pendingRecognition;
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private boolean ttsReady;
    private String pendingSpeech;
    private View overlay;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        preferences = getSharedPreferences("jarvis-connection", MODE_PRIVATE);
        serverOrigin = validOrigin(preferences.getString("server-origin", ""));
        if (serverOrigin == null) serverOrigin = "";
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BACKGROUND);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(16), 0, dp(8), 0);
        TextView title = label("JARVIS", 17);
        title.setTextColor(Color.rgb(158, 219, 255));
        bar.addView(title, new LinearLayout.LayoutParams(0, dp(52), 1));
        Button connection = button("Connection");
        connection.setOnClickListener(v -> showSetup());
        bar.addView(connection);
        root.addView(bar);
        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        createWebView();
        if (validOrigin(serverOrigin) == null) showSetup(); else connect();
    }

    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(BACKGROUND);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " JARVISAndroid/0.2");
        webView.addJavascriptInterface(new VoiceBridge(), "JarvisAndroid");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                // Audio uses the explicit native push-to-talk bridge instead.
                request.deny();
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (sameOrigin(uri)) return false;
                if (request.isForMainFrame() && ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (Exception ignored) { showError("No browser is available to open this link."); }
                }
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return sameOrigin(request.getUrl()) ? null : blockedResource();
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                trustedPage = false;
                loadingFailed = false;
                if (!sameOrigin(Uri.parse(url))) {
                    view.stopLoading();
                    showError("The server redirected outside your saved HTTPS address. Check Connection.");
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                trustedPage = !loadingFailed && sameOrigin(Uri.parse(url));
                if (trustedPage) hideOverlay();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("Cannot reach your computer. Start JARVIS on Windows, keep it awake, and check your private connection.");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showError("The computer returned HTTP " + response.getStatusCode() + ". Check that this address runs JARVIS.");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showError("The HTTPS certificate could not be verified. Check your server certificate and phone date; insecure connections are blocked.");
            }
        });
        ServiceWorkerController workers = ServiceWorkerController.getInstance();
        workers.getServiceWorkerWebSettings().setAllowContentAccess(false);
        workers.getServiceWorkerWebSettings().setAllowFileAccess(false);
        workers.setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return sameOrigin(request.getUrl()) ? null : blockedResource();
            }
        });
        content.addView(webView, new FrameLayout.LayoutParams(-1, -1));
    }

    private WebResourceResponse blockedResource() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked",
                Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(new byte[0]));
    }

    private String validOrigin(String value) {
        try {
            URI uri = new URI(value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                    || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                    || (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath()))
                    || uri.getPort() > 65535 || uri.getPort() == 0) return null;
            return "https://" + uri.getRawAuthority().toLowerCase(Locale.ROOT);
        } catch (Exception ignored) { return null; }
    }

    private boolean sameOrigin(Uri uri) {
        if (serverOrigin == null || serverOrigin.isEmpty() || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        Uri base = Uri.parse(serverOrigin);
        int port = uri.getPort() == -1 ? 443 : uri.getPort();
        int basePort = base.getPort() == -1 ? 443 : base.getPort();
        return uri.getHost() != null && uri.getHost().equalsIgnoreCase(base.getHost())
                && port == basePort && uri.getUserInfo() == null;
    }

    private LinearLayout panel(String title, String explanation) {
        hideOverlay();
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER_VERTICAL);
        panel.setPadding(dp(28), dp(28), dp(28), dp(28));
        panel.setBackgroundColor(BACKGROUND);
        panel.addView(label(title, 30));
        TextView body = label(explanation, 16);
        body.setPadding(0, dp(18), 0, dp(24));
        body.setTextColor(Color.rgb(168, 179, 198));
        panel.addView(body);
        overlay = panel;
        content.addView(panel, new FrameLayout.LayoutParams(-1, -1));
        return panel;
    }

    private void showSetup() {
        trustedPage = false;
        webView.stopLoading();
        stopVoice();
        LinearLayout panel = panel("Your assistant,\nwith you.",
                "Connect to JARVIS on your Windows computer. Paste its private HTTPS address, such as the address from Tailscale Serve. Your computer must be online for AI replies.");
        EditText address = new EditText(this);
        address.setSingleLine(true);
        address.setTextColor(Color.WHITE);
        address.setHintTextColor(Color.rgb(130, 148, 171));
        address.setHint("https://your-computer.example");
        address.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        address.setText(serverOrigin);
        panel.addView(address, new LinearLayout.LayoutParams(-1, dp(58)));
        Button connect = button("Connect to my computer");
        panel.addView(connect, new LinearLayout.LayoutParams(-1, dp(58)));
        connect.setOnClickListener(v -> {
            String origin = validOrigin(address.getText().toString());
            if (origin == null) { address.setError("Enter an HTTPS address without a path, token, or password."); return; }
            serverOrigin = origin;
            preferences.edit().putString("server-origin", origin).apply();
            ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(address.getWindowToken(), 0);
            connect();
        });
        TextView note = label("Enter your access token on the JARVIS unlock screen. Voice works when you tap the microphone; reminders require the app to stay open.", 13);
        note.setPadding(0, dp(20), 0, 0);
        note.setTextColor(Color.rgb(130, 148, 171));
        panel.addView(note);
    }

    private void connect() {
        trustedPage = false;
        loadingFailed = false;
        panel("Connecting…", "Opening your private JARVIS server. Keep your computer online and your private connection active.");
        webView.loadUrl(serverOrigin + "/");
    }

    private void showError(String message) {
        loadingFailed = true;
        trustedPage = false;
        stopVoice();
        LinearLayout panel = panel("Let’s reconnect.", message);
        Button retry = button("Retry connection");
        retry.setOnClickListener(v -> connect());
        panel.addView(retry, new LinearLayout.LayoutParams(-1, dp(58)));
        Button change = button("Change computer address");
        change.setOnClickListener(v -> showSetup());
        panel.addView(change, new LinearLayout.LayoutParams(-1, dp(58)));
    }

    private void hideOverlay() {
        if (overlay != null) content.removeView(overlay);
        overlay = null;
    }

    private TextView label(String text, int size) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(Color.WHITE);
        view.setGravity(Gravity.CENTER_VERTICAL);
        return view;
    }

    private Button button(String title) {
        Button button = new Button(this);
        button.setText(title);
        button.setTextSize(13);
        button.setAllCaps(false);
        return button;
    }

    private int dp(int amount) { return Math.round(amount * getResources().getDisplayMetrics().density); }

    private void event(String name, String property, Object value) {
        if (!trustedPage || webView == null || !sameOrigin(Uri.parse(webView.getUrl() == null ? "" : webView.getUrl()))) return;
        try {
            JSONObject detail = new JSONObject().put(property, value);
            webView.evaluateJavascript("window.dispatchEvent(new CustomEvent(" + JSONObject.quote(name)
                    + ",{detail:" + detail.toString() + "}));", null);
        } catch (Exception ignored) { /* A navigated or destroyed page needs no event. */ }
    }

    private void listen() {
        if (!trustedPage || !foreground) return;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE_REQUEST);
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            event("jarvis-voice-error", "message", "No Android speech recognizer is installed. Install or enable your phone’s speech service, or type your message.");
            return;
        }
        stopListening();
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(this);
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        try {
            recognizer.startListening(intent);
            event("jarvis-voice-state", "listening", true);
        } catch (Exception ignored) {
            stopListening();
            event("jarvis-voice-error", "message", "Android could not start voice input. Try again or type your message.");
        }
    }

    private void stopListening() {
        if (recognizer != null) {
            recognizer.setRecognitionListener(null);
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
        event("jarvis-voice-state", "listening", false);
    }

    private void speak(String text) {
        if (!trustedPage || !foreground || text == null || text.trim().isEmpty()) return;
        pendingSpeech = text.substring(0, Math.min(text.length(), TextToSpeech.getMaxSpeechInputLength() - 1));
        if (tts == null) {
            tts = new TextToSpeech(this, status -> {
                ttsReady = status == TextToSpeech.SUCCESS;
                if (ttsReady) {
                    tts.setLanguage(Locale.getDefault());
                    speakPending();
                } else event("jarvis-voice-error", "message", "Android text-to-speech is unavailable. Enable a speech engine in phone settings.");
            });
        } else if (ttsReady) speakPending();
    }

    private void speakPending() {
        if (ttsReady && pendingSpeech != null && trustedPage && foreground) {
            tts.speak(pendingSpeech, TextToSpeech.QUEUE_FLUSH, null, "jarvis-reply");
            pendingSpeech = null;
        }
    }

    private void stopVoice() {
        stopListening();
        pendingSpeech = null;
        if (tts != null) tts.stop();
    }

    private final class VoiceBridge {
        @JavascriptInterface public void startListening() { runOnUiThread(() -> listen()); }
        @JavascriptInterface public void stopListening() {
            runOnUiThread(() -> {
                if (recognizer != null) {
                    try {
                        // Finish the utterance and keep the listener for final onResults.
                        recognizer.stopListening();
                    } catch (Exception ignored) {
                        MainActivity.this.stopListening();
                        event("jarvis-voice-error", "message", "Android could not finish voice input. Try again or type your message.");
                    }
                }
                event("jarvis-voice-state", "listening", false);
            });
        }
        @JavascriptInterface public void speak(String text) { runOnUiThread(() -> MainActivity.this.speak(text)); }
        @JavascriptInterface public void stopSpeaking() { runOnUiThread(() -> { pendingSpeech = null; if (tts != null) tts.stop(); }); }
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (code != MICROPHONE_REQUEST) return;
        if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) {
            if (foreground) listen(); else pendingRecognition = true;
        }
        else event("jarvis-voice-error", "message", "Microphone permission is needed for voice input. Enable it in Android app settings, or type your message.");
    }
    @Override public void onResults(Bundle results) {
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        stopListening();
        if (matches != null && !matches.isEmpty()) event("jarvis-transcript", "text", matches.get(0));
        else event("jarvis-voice-error", "message", "No speech was detected. Tap the microphone and try again.");
    }
    @Override public void onError(int code) {
        stopListening();
        String message = code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "Enable microphone permission in Android app settings."
                : code == SpeechRecognizer.ERROR_NETWORK || code == SpeechRecognizer.ERROR_NETWORK_TIMEOUT ? "Android’s speech service could not connect. Check your connection or download an offline speech language."
                : code == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? "Voice input is busy. Wait a moment and tap the microphone again."
                : "No speech was recognized. Tap the microphone and try again, or type your message.";
        event("jarvis-voice-error", "message", message);
    }
    @Override public void onReadyForSpeech(Bundle params) {}
    @Override public void onBeginningOfSpeech() {}
    @Override public void onRmsChanged(float rms) {}
    @Override public void onBufferReceived(byte[] buffer) {}
    @Override public void onEndOfSpeech() {}
    @Override public void onPartialResults(Bundle results) {}
    @Override public void onEvent(int type, Bundle params) {}

    @Override protected void onPause() {
        foreground = false;
        pendingRecognition = false;
        stopVoice();
        webView.onPause();
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (webView != null) webView.onResume();
        if (pendingRecognition) { pendingRecognition = false; listen(); }
    }
    @Override public void onBackPressed() {
        if (overlay != null && !serverOrigin.isEmpty() && !loadingFailed) { connect(); return; }
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }
    @Override protected void onDestroy() {
        stopVoice();
        trustedPage = false;
        if (tts != null) { tts.shutdown(); tts = null; }
        if (webView != null) { webView.removeJavascriptInterface("JarvisAndroid"); webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
