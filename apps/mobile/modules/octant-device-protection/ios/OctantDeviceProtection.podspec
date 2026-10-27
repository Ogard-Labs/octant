Pod::Spec.new do |s|
  s.name           = 'OctantDeviceProtection'
  s.version        = '0.1.0'
  s.summary        = 'Octant device protection'
  s.description    = 'Covers Octant in the app switcher and on a recorded screen, and reports where its keys are kept.'
  s.license        = 'UNLICENSED'
  s.author         = 'Octant'
  s.homepage       = 'https://octant.sh'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
