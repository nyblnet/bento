package slides.bento.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var pendingSaveContent: String? = null
    private var pendingFileChooser: ValueCallback<Array<Uri>>? = null

    private val localDeck get() = File(filesDir, "bento.html")

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            mediaPlaybackRequiresUserGesture = false
        }

        webView.addJavascriptInterface(Bridge(), "BentoNative")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                view.evaluateJavascript(SHIM_JS, null)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                view.evaluateJavascript(SHIM_JS, null)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                pendingFileChooser?.onReceiveValue(null)
                pendingFileChooser = callback
                startActivityForResult(params.createIntent(), REQ_OPEN)
                return true
            }
        }

        val url = if (localDeck.exists()) Uri.fromFile(localDeck).toString()
                  else "file:///android_asset/bento.html"
        webView.loadUrl(url)

        checkForUpdate()
    }

    /** Fetches the latest bento release; the new deck is used on next launch. */
    private fun checkForUpdate() {
        Thread {
            try {
                val prefs = getSharedPreferences("ota", MODE_PRIVATE)
                val api = URL("https://api.github.com/repos/nyblnet/bento/releases/latest")
                    .openConnection() as HttpURLConnection
                api.setRequestProperty("Accept", "application/vnd.github+json")
                api.connectTimeout = 15000
                api.readTimeout = 15000
                val json = JSONObject(api.inputStream.bufferedReader().use { it.readText() })

                val tag = json.getString("tag_name")
                if (tag == prefs.getString("tag", null)) return@Thread

                var assetUrl: String? = null
                val assets = json.getJSONArray("assets")
                for (i in 0 until assets.length()) {
                    val a = assets.getJSONObject(i)
                    if (a.getString("name").endsWith(".html")) {
                        assetUrl = a.getString("browser_download_url")
                        break
                    }
                }
                if (assetUrl == null) return@Thread

                val dl = URL(assetUrl).openConnection() as HttpURLConnection
                dl.connectTimeout = 15000
                dl.readTimeout = 60000
                val body = dl.inputStream.use { it.readBytes() }

                // Sanity check before swapping in the new deck.
                if (body.size < 100_000 || !String(body, 0, 4096).contains("<")) return@Thread

                val tmp = File(filesDir, "bento.html.tmp")
                tmp.writeBytes(body)
                if (tmp.renameTo(localDeck)) {
                    prefs.edit().putString("tag", tag).apply()
                }
            } catch (_: Exception) {
                // Offline or API hiccup — keep the current deck.
            }
        }.start()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        when (requestCode) {
            REQ_SAVE -> {
                val content = pendingSaveContent
                pendingSaveContent = null
                val uri = data?.data
                if (resultCode == RESULT_OK && uri != null && content != null) {
                    try {
                        contentResolver.openOutputStream(uri, "wt")?.use {
                            it.write(content.toByteArray())
                        }
                    } catch (_: Exception) {
                    }
                }
            }
            REQ_OPEN -> {
                val callback = pendingFileChooser
                pendingFileChooser = null
                val uri = data?.data
                callback?.onReceiveValue(
                    if (resultCode == RESULT_OK && uri != null) arrayOf(uri) else null
                )
            }
            else -> super.onActivityResult(requestCode, resultCode, data)
        }
    }

    inner class Bridge {
        @JavascriptInterface
        fun saveFile(name: String, content: String) {
            pendingSaveContent = content
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "text/html"
                putExtra(Intent.EXTRA_TITLE, name)
            }
            runOnUiThread { startActivityForResult(intent, REQ_SAVE) }
        }
    }

    companion object {
        private const val REQ_SAVE = 1
        private const val REQ_OPEN = 2

        // Bridges the File System Access API (absent in WebView) to native dialogs.
        private val SHIM_JS = """
            (function () {
              if (window.__bentoShim) return;
              window.__bentoShim = true;

              window.showSaveFilePicker = function (opts) {
                var name = (opts && opts.suggestedName) || 'presentation.bento.html';
                return Promise.resolve({
                  kind: 'file',
                  name: name,
                  createWritable: function () {
                    var parts = [];
                    return Promise.resolve({
                      write: function (d) {
                        if (d && typeof d === 'object' && d.data !== undefined &&
                            !(d instanceof Blob) && !(d instanceof ArrayBuffer) && !ArrayBuffer.isView(d)) {
                          d = d.data;
                        }
                        parts.push(d);
                        return Promise.resolve();
                      },
                      truncate: function () { return Promise.resolve(); },
                      seek: function () { return Promise.resolve(); },
                      close: function () {
                        return new Blob(parts).text().then(function (t) {
                          BentoNative.saveFile(name, t);
                        });
                      }
                    });
                  }
                });
              };

              window.showOpenFilePicker = function () {
                return new Promise(function (resolve, reject) {
                  var inp = document.createElement('input');
                  inp.type = 'file';
                  inp.accept = '.html,text/html';
                  inp.onchange = function () {
                    var f = inp.files && inp.files[0];
                    if (!f) { reject(new DOMException('Aborted', 'AbortError')); return; }
                    resolve([{
                      kind: 'file',
                      name: f.name,
                      getFile: function () { return Promise.resolve(f); }
                    }]);
                  };
                  inp.click();
                });
              };
            })();
        """
    }
}
