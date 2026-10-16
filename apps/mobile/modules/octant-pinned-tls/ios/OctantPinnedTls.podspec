Pod::Spec.new do |s|
  s.name           = 'OctantPinnedTls'
  s.version        = '0.1.0'
  s.summary        = 'Octant pinned listener transport'
  s.description    = 'A TLS exchange with a paired Octant listener, held to its certificate pin.'
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
