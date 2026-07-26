# The JS bridge is called reflectively from WebView JS — keep its methods.
-keepclassmembers class slides.bento.app.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
