Pod::Spec.new do |s|
  s.name           = 'OctantPush'
  s.version        = '0.1.0'
  s.summary        = 'Octant push notifications'
  s.description    = 'The phone side of sealed push notifications: permission, push token, and per-computer notification keys.'
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
