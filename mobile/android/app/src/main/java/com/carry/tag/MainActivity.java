package com.carry.tag;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CarryLocationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
