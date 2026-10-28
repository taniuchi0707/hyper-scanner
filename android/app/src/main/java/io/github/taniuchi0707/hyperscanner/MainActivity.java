package io.github.taniuchi0707.hyperscanner;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Web 版の Hyper Scanner をそのまま動かす入れ物。
 * アプリ内の https のアドレスで画面を開くので、ブラウザと同じようにカメラや保存が使える。
 * ブラウザにない部分（PDF の保存・共有、写真の受け取り、戻るボタン）だけをここで受け持つ。
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/www/index.html";
    private static final int REQ_FILES = 10;
    private static final int REQ_CAMERA = 11;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;

    private final List<Uri> shared = new ArrayList<>();
    private boolean sharedPending = false;
    private int sharedGeneration = 0;

    private File incoming;
    private OutputStream incomingOut;
    private Uri lastSaved;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/shared/", this::openShared)
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) return false;
                // アプリの外へのリンクはブラウザで開く
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // 開けるアプリがない
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handlePermission(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                boolean multiple = params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;
                Intent pick;
                if (Build.VERSION.SDK_INT >= 33) {
                    pick = new Intent(MediaStore.ACTION_PICK_IMAGES);
                    if (multiple) pick.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit());
                } else {
                    pick = new Intent(Intent.ACTION_GET_CONTENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("image/*");
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
                }
                try {
                    startActivityForResult(pick, REQ_FILES);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        web.addJavascriptInterface(new Bridge(), "HyperScannerNative");
        handleIntent(getIntent());
        web.loadUrl(START_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (handleIntent(intent)) {
            web.evaluateJavascript("window.HyperScanner && window.HyperScanner.checkShared && window.HyperScanner.checkShared()", null);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        closeIncoming();
        web.destroy();
        super.onDestroy();
    }

    // 画面側で開いているもの（カメラ・編集・シート）があれば閉じ、なければアプリを閉じる
    @Override
    public void onBackPressed() {
        web.evaluateJavascript(
                "(window.HyperScanner && window.HyperScanner.back && window.HyperScanner.back()) ? 'handled' : ''",
                value -> {
                    if (!"\"handled\"".equals(value)) finish();
                });
    }

    // ---------- カメラの許可 ----------

    private void handlePermission(PermissionRequest request) {
        Uri origin = request.getOrigin();
        boolean wantsCamera = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
        }
        if (!wantsCamera || origin == null || !HOST.equals(origin.getHost())) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            return;
        }
        if (pendingPermission != null) pendingPermission.deny();
        pendingPermission = request;
        requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQ_CAMERA || pendingPermission == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingPermission.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingPermission.deny();
        }
        pendingPermission = null;
    }

    // ---------- 写真の選択 ----------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILES) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] uris = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                uris = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) uris[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                uris = new Uri[]{data.getData()};
            }
        }
        if (fileCallback != null) fileCallback.onReceiveValue(uris);
        fileCallback = null;
    }

    // ---------- 共有で受け取った写真 ----------

    private boolean handleIntent(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty() && intent.getClipData() != null && (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action))) {
            ClipData clip = intent.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
        }
        if (uris.isEmpty()) return false;
        synchronized (shared) {
            shared.clear();
            shared.addAll(uris);
            sharedPending = true;
            sharedGeneration++;
        }
        return true;
    }

    // https://appassets.androidplatform.net/shared/<回>/<番号> で、受け取った写真を画面に渡す
    private WebResourceResponse openShared(String path) {
        try {
            String[] parts = path.split("/");
            int index = Integer.parseInt(parts[parts.length - 1]);
            Uri uri;
            synchronized (shared) {
                if (index < 0 || index >= shared.size()) return null;
                uri = shared.get(index);
            }
            ContentResolver cr = getContentResolver();
            String type = cr.getType(uri);
            InputStream in = cr.openInputStream(uri);
            return new WebResourceResponse(type != null ? type : "image/jpeg", null, in);
        } catch (Exception e) {
            return null;
        }
    }

    // ---------- PDF の保存・共有 ----------

    private void closeIncoming() {
        if (incomingOut != null) {
            try {
                incomingOut.close();
            } catch (IOException ignored) {
                // 閉じられなくても続ける
            }
            incomingOut = null;
        }
    }

    private static String safeName(String name) {
        String s = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (s.isEmpty()) s = "scan.pdf";
        if (!s.toLowerCase().endsWith(".pdf")) s += ".pdf";
        return s;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    // 「ダウンロード/Hyper Scanner」に保存する
    private void save(String name) throws IOException {
        ContentResolver cr = getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Hyper Scanner");
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("保存先を作れませんでした");
        try (OutputStream out = cr.openOutputStream(uri); InputStream in = new FileInputStream(incoming)) {
            if (out == null) throw new IOException("保存先に書き込めませんでした");
            copy(in, out);
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, values, null, null);
        lastSaved = uri;
        //noinspection ResultOfMethodCallIgnored
        incoming.delete();
    }

    private void share(String name) throws IOException {
        File dir = new File(getCacheDir(), "share");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("共有用のフォルダを作れませんでした");
        File[] old = dir.listFiles();
        if (old != null) {
            //noinspection ResultOfMethodCallIgnored
            for (File f : old) f.delete();
        }
        File file = new File(dir, name);
        if (!incoming.renameTo(file)) throw new IOException("共有用のファイルを作れませんでした");
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", file);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("application/pdf");
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri(name, uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, name);
        runOnUiThread(() -> startActivity(chooser));
    }

    private void applyBars(String color, boolean lightIcons) {
        try {
            int c = Color.parseColor(color);
            Window w = getWindow();
            w.setStatusBarColor(c);
            w.setNavigationBarColor(c);
            if (Build.VERSION.SDK_INT >= 30) {
                WindowInsetsController ic = w.getInsetsController();
                if (ic != null) {
                    int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    ic.setSystemBarsAppearance(lightIcons ? mask : 0, mask);
                }
            } else {
                View decor = w.getDecorView();
                int light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                int flags = decor.getSystemUiVisibility();
                decor.setSystemUiVisibility(lightIcons ? (flags | light) : (flags & ~light));
            }
        } catch (IllegalArgumentException ignored) {
            // 色の書き方が違うときは何もしない
        }
    }

    /** 画面（JavaScript）から window.HyperScannerNative として呼ぶ */
    private final class Bridge {
        @JavascriptInterface
        public boolean isApp() {
            return true;
        }

        // 大きな PDF は base64 の切れ端に分けて受け取る
        @JavascriptInterface
        public synchronized boolean beginFile() {
            closeIncoming();
            try {
                incoming = new File(getCacheDir(), "export.part");
                incomingOut = new FileOutputStream(incoming);
                return true;
            } catch (IOException e) {
                return false;
            }
        }

        @JavascriptInterface
        public synchronized boolean appendChunk(String base64) {
            if (incomingOut == null) return false;
            try {
                incomingOut.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (IOException | IllegalArgumentException e) {
                return false;
            }
        }

        // action: "save"（ダウンロードに保存）か "share"（共有メニューを開く）
        @JavascriptInterface
        public synchronized String finishFile(String name, String action) {
            if (incomingOut == null || incoming == null) return "error";
            closeIncoming();
            try {
                if ("share".equals(action)) {
                    share(safeName(name));
                    return "shared";
                }
                save(safeName(name));
                return "saved";
            } catch (Exception e) {
                return "error";
            }
        }

        @JavascriptInterface
        public void openSaved() {
            final Uri uri = lastSaved;
            if (uri == null) return;
            runOnUiThread(() -> {
                Intent view = new Intent(Intent.ACTION_VIEW);
                view.setDataAndType(uri, "application/pdf");
                view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivity(view);
                } catch (ActivityNotFoundException ignored) {
                    // PDF を開けるアプリがない
                }
            });
        }

        // 共有で受け取ったまま、まだ画面に渡していない写真のアドレス（JSON の配列）
        @JavascriptInterface
        public String takeShared() {
            synchronized (shared) {
                if (!sharedPending) return "[]";
                sharedPending = false;
                StringBuilder sb = new StringBuilder("[");
                for (int i = 0; i < shared.size(); i++) {
                    if (i > 0) sb.append(',');
                    sb.append("\"/shared/").append(sharedGeneration).append('/').append(i).append('"');
                }
                return sb.append(']').toString();
            }
        }

        @JavascriptInterface
        public void setBars(String color, boolean lightIcons) {
            runOnUiThread(() -> applyBars(color, lightIcons));
        }
    }
}
